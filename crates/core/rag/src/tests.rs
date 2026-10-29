use super::*;
use crate::store::*;

#[tokio::test]
async fn local_embedder_batches_in_input_order() {
    let embedder = Embedder::Local { dims: 32 };
    let inputs = vec!["oak tree".to_owned(), "river stone".to_owned()];

    let batch = embedder
        .embed_batch(&inputs)
        .await
        .expect("local batch embedding must succeed");

    assert_eq!(batch.len(), inputs.len());
    for (input, vector) in inputs.iter().zip(&batch) {
        assert_eq!(*vector, embedder.embed(input).await.expect("single embed"));
        assert_eq!(vector.len(), 32);
    }
    assert!(embedder
        .embed_batch(&[])
        .await
        .expect("empty batch")
        .is_empty());
}

#[test]
fn remote_embedding_batch_reorders_by_provider_index() {
    let body = serde_json::json!({
        "data": [
            { "index": 1, "embedding": [0.0, 1.0] },
            { "index": 0, "embedding": [1.0, 0.0] }
        ]
    });

    let vectors = parse_remote_embedding_batch(&body, 2, 2)
        .expect("provider order must not change source order");

    assert_eq!(vectors, vec![vec![1.0, 0.0], vec![0.0, 1.0]]);
}

#[test]
fn remote_embedding_batch_rejects_missing_duplicate_and_wrong_width_vectors() {
    let missing = serde_json::json!({ "data": [{ "index": 0, "embedding": [1.0, 0.0] }] });
    assert!(parse_remote_embedding_batch(&missing, 2, 2).is_err());

    let duplicate = serde_json::json!({
        "data": [
            { "index": 0, "embedding": [1.0, 0.0] },
            { "index": 0, "embedding": [0.0, 1.0] }
        ]
    });
    assert!(parse_remote_embedding_batch(&duplicate, 2, 2).is_err());

    let wrong_width = serde_json::json!({
        "data": [{ "index": 0, "embedding": [1.0] }]
    });
    assert!(parse_remote_embedding_batch(&wrong_width, 1, 2).is_err());
}

/// **ResourceKey regression (task C2, deliverable #1): behavior-preserving.**
///
/// The retrieval plane derives a chunk owner and the per-caller filter fields
/// from a `ResourceKey`, both byte-identical to the pre-ResourceKey values —
/// including the collapse (org-only/unattributed ⇒ `(None, None)`) and the
/// UNBOUND-node no-op (`node_bound = false` disables filtering regardless of
/// the key).
#[test]
fn resource_key_retrieval_derivation_is_behavior_preserving() {
    // Owner: attributed and collapsed shapes match `RetrievalOwner::owned`.
    for (user, org) in [
        (Some("u1"), Some("acme")),
        (Some("u1"), None),
        (None, None),
        (None, Some("acme")),
    ] {
        let key = ResourceKey::owned(user, org);
        let via_key = RetrievalOwner::from_resource_key(&key);
        let expected = RetrievalOwner::owned(
            // the key's collapse: org dropped when user absent
            if user.is_some() { user } else { None },
            if user.is_some() { org } else { None },
            None,
        );
        assert_eq!(via_key.user_id, expected.user_id);
        assert_eq!(via_key.org_id, expected.org_id);
        assert_eq!(via_key.visibility, None);
    }

    // Filter on a BOUND node carries the caller identity through.
    let bound = RetrievalOptions::default()
        .with_caller_key(&ResourceKey::owned(Some("u1"), Some("acme")), true);
    assert!(bound.node_bound);
    assert_eq!(bound.caller_user_id.as_deref(), Some("u1"));
    assert_eq!(bound.caller_org_id.as_deref(), Some("acme"));

    // UNBOUND node: filtering stays a total no-op regardless of the key.
    let unbound = RetrievalOptions::default()
        .with_caller_key(&ResourceKey::owned(Some("u1"), Some("acme")), false);
    assert!(!unbound.node_bound);
}

/// The registry defaults the Core-side resolver would supply, inlined so these
/// primitive tests stay free of the model registry (a Core type).
const TEST_EMBED_DIMS: usize = 768;
const TEST_RERANKER_ID: &str = "BAAI/bge-reranker";

/// In-memory store at the default dims + reranker id (the pre-extraction
/// `open_in_memory()` semantics).
fn mem_store() -> RetrievalStore {
    RetrievalStore::open_in_memory(TEST_EMBED_DIMS, TEST_RERANKER_ID.to_owned()).unwrap()
}

async fn seed(store: &RetrievalStore) {
    store
        .index_chunk(
            "m1",
            ChunkSource::Memory,
            None,
            "The user prefers dark mode and concise answers.",
            RetrievalOwner::shared(),
        )
        .await
        .unwrap();
    store
        .index_chunk(
            "s1",
            ChunkSource::Space,
            Some("docs"),
            "Ryu Core runs on port 7980 and routes chat through adapters.",
            RetrievalOwner::shared(),
        )
        .await
        .unwrap();
    store
        .index_chunk(
            "s2",
            ChunkSource::Space,
            Some("docs"),
            "The gateway enforces firewall, routing, and budgets.",
            RetrievalOwner::shared(),
        )
        .await
        .unwrap();
    store
        .index_chunk(
            "s3",
            ChunkSource::Space,
            Some("recipes"),
            "Preheat the oven to 200 degrees and bake the bread.",
            RetrievalOwner::shared(),
        )
        .await
        .unwrap();
}

#[tokio::test]
async fn retrieves_relevant_chunk_grounding_the_query() {
    let store = mem_store();
    seed(&store).await;

    let opts = RetrievalOptions {
        top_k: 1,
        ..Default::default()
    };
    let hits = store
        .retrieve("what port does ryu core run on", &opts)
        .await
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, "s1");
    assert!(hits[0].score > 0.0);
}

/// A partition too large for the vector cache is scored from the row
/// stream (only its candidates' scores are kept), with the same answers as
/// the cached path and nothing left in memory.
#[tokio::test]
async fn an_uncacheable_partition_is_scored_from_the_stream() {
    let store = mem_store();
    seed(&store).await;
    let opts = RetrievalOptions {
        top_k: 4,
        ..Default::default()
    };
    let query = "what port does ryu core run on";
    let cached = store.retrieve(query, &opts).await.unwrap();
    assert_eq!(cached[0].id, "s1");

    store.drop_partitions(|_| true);
    let known: Vec<PartitionKey> = {
        let model = store.embedder_snapshot().model_id().to_string();
        vec![
            PartitionKey::new(&model, ChunkSource::Memory.as_str(), None),
            PartitionKey::new(&model, ChunkSource::Space.as_str(), Some("docs")),
            PartitionKey::new(&model, ChunkSource::Space.as_str(), Some("recipes")),
        ]
    };
    store
        .too_large
        .lock()
        .unwrap()
        .extend(known.iter().cloned());
    let streamed = store.retrieve(query, &opts).await.unwrap();
    assert_eq!(
        streamed.iter().map(|hit| &hit.id).collect::<Vec<_>>(),
        cached.iter().map(|hit| &hit.id).collect::<Vec<_>>()
    );
    for key in &known {
        assert!(!store.vectors.is_hydrated(&key.name()));
    }
    // Dropping partitions forgets the oversize marks.
    store.drop_partitions(|_| true);
    assert!(store.too_large.lock().unwrap().is_empty());
}

#[tokio::test]
async fn merges_memory_and_spaces_ranked_by_relevance() {
    let store = mem_store();
    seed(&store).await;

    let opts = RetrievalOptions {
        top_k: 5,
        ..Default::default()
    };
    let hits = store
        .retrieve("dark mode answers and core port", &opts)
        .await
        .unwrap();
    // Both a memory chunk and a Space chunk should be present in the merge.
    assert!(hits.iter().any(|c| c.source == ChunkSource::Memory));
    assert!(hits.iter().any(|c| c.source == ChunkSource::Space));
    // Sorted by descending score.
    for pair in hits.windows(2) {
        assert!(pair[0].score >= pair[1].score);
    }
}

#[tokio::test]
async fn space_filter_restricts_search() {
    let store = mem_store();
    seed(&store).await;

    let opts = RetrievalOptions {
        top_k: 10,
        space_ids: Some(vec!["recipes".to_owned()]),
        include_memory: false,
        min_score: 0.0,
        rerank_candidates: None,
        ..Default::default()
    };
    let hits = store.retrieve("oven bread bake", &opts).await.unwrap();
    assert!(!hits.is_empty());
    assert!(hits
        .iter()
        .all(|c| c.space_id.as_deref() == Some("recipes")));
}

/// Memory-scope filter: a project-scoped memory chunk is only retrieved when
/// the caller's `read_levels` includes `project` AND `project_id` matches; a
/// user-only caller never sees it.
#[tokio::test]
async fn memory_level_filter_gates_project_scope() {
    let store = mem_store();
    store
        .index_memory_chunk(
            "mu",
            "the user prefers concise answers",
            "user",
            None,
            "preference",
            3,
            RetrievalOwner::shared(),
        )
        .await
        .unwrap();
    store
        .index_memory_chunk(
            "mp",
            "this project uses pnpm and vitest",
            "project",
            Some("/proj/x"),
            "project_context",
            4,
            RetrievalOwner::shared(),
        )
        .await
        .unwrap();

    // User-only agent: never sees the project chunk, even inside project X.
    let user_only = RetrievalOptions {
        top_k: 10,
        read_levels: Some(vec!["user".to_owned()]),
        project_id: Some("/proj/x".to_owned()),
        ..Default::default()
    };
    let hits = store
        .retrieve("what does the project use", &user_only)
        .await
        .unwrap();
    assert!(
        hits.iter().all(|c| c.id != "mp"),
        "project chunk must be hidden from a user-only agent"
    );

    // Project-enabled agent in project X: the project chunk is retrievable.
    let in_x = RetrievalOptions {
        top_k: 10,
        read_levels: Some(vec!["user".to_owned(), "project".to_owned()]),
        project_id: Some("/proj/x".to_owned()),
        ..Default::default()
    };
    let hits_x = store
        .retrieve("what does the project use", &in_x)
        .await
        .unwrap();
    assert!(
        hits_x.iter().any(|c| c.id == "mp"),
        "project chunk must surface inside its project"
    );

    // Same agent in a DIFFERENT project: the project chunk is excluded.
    let in_y = RetrievalOptions {
        top_k: 10,
        read_levels: Some(vec!["user".to_owned(), "project".to_owned()]),
        project_id: Some("/proj/y".to_owned()),
        ..Default::default()
    };
    let hits_y = store
        .retrieve("what does the project use", &in_y)
        .await
        .unwrap();
    assert!(
        hits_y.iter().all(|c| c.id != "mp"),
        "project chunk must not leak into another project"
    );
}

#[tokio::test]
async fn empty_space_list_searches_memory_only() {
    let store = mem_store();
    seed(&store).await;

    let opts = RetrievalOptions {
        top_k: 10,
        space_ids: Some(vec![]),
        include_memory: true,
        min_score: 0.0,
        rerank_candidates: None,
        ..Default::default()
    };
    let hits = store.retrieve("dark mode", &opts).await.unwrap();
    assert!(hits.iter().all(|c| c.source == ChunkSource::Memory));
}

#[tokio::test]
async fn top_k_limits_results() {
    let store = mem_store();
    seed(&store).await;

    let opts = RetrievalOptions {
        top_k: 2,
        ..Default::default()
    };
    let hits = store
        .retrieve("ryu core gateway docs", &opts)
        .await
        .unwrap();
    assert!(hits.len() <= 2);
}

#[test]
fn context_block_is_none_when_empty() {
    assert!(build_context_block(&[]).is_none());
}

#[test]
fn context_block_labels_sources() {
    let chunks = vec![
        ScoredChunk {
            id: "m1".into(),
            source: ChunkSource::Memory,
            space_id: None,
            content: "remembered fact".into(),
            score: 0.9,
        },
        ScoredChunk {
            id: "s1".into(),
            source: ChunkSource::Space,
            space_id: Some("docs".into()),
            content: "space fact".into(),
            score: 0.8,
        },
    ];
    let block = build_context_block(&chunks).unwrap();
    assert!(block.contains("Memory"));
    assert!(block.contains("Space:docs"));
    assert!(block.contains("remembered fact"));
}

#[test]
fn cosine_handles_length_mismatch() {
    assert_eq!(cosine_similarity(&[1.0, 0.0], &[1.0]), 0.0);
}

#[test]
fn blob_cosine_matches_decoded_cosine() {
    let query = [0.3f32, -1.2, 0.0, 4.5];
    for stored in [
        vec![0.3f32, -1.2, 0.0, 4.5],
        vec![1.0, 2.0, -3.0, 0.25],
        vec![0.0, 0.0, 0.0, 0.0],
        vec![1.0, 2.0],
    ] {
        let blob = encode_embedding(&stored);
        assert_eq!(
            cosine_similarity_blob(&query, &blob).to_bits(),
            cosine_similarity(&query, &decode_embedding_blob(&blob)).to_bits()
        );
    }
}

#[test]
fn embedding_round_trips_through_blob() {
    let vec = vec![0.5f32, -0.25, 1.0, 0.0];
    let decoded = decode_embedding_blob(&encode_embedding(&vec));
    assert_eq!(vec, decoded);
}

// ── AC4: registry swap + reranker reorders ────────────────────────────────

/// AC4a: swapping the embedding model (via the resolver-supplied config)
/// produces the new id.
#[tokio::test]
async fn resolver_config_uses_new_embed_model_id() {
    // A local-dims store with a distinct default reranker id (what the Core
    // resolver would inject from a swapped registry).
    let store = RetrievalStore::open_in_memory(256, "custom/reranker-test".to_owned()).unwrap();

    // The store should report the injected model id.
    assert_eq!(
        store.embedder_model_id(),
        "local-hashing",
        "local mode always returns 'local-hashing' (no base URL set)"
    );
    assert_eq!(store.reranker_model_id(), "custom/reranker-test");
}

#[tokio::test]
async fn reindex_stale_embeddings_restores_retrieval_and_is_idempotent() {
    let store = mem_store();
    store
        .index_chunk(
            "stale",
            ChunkSource::Memory,
            None,
            "the user's favorite color is orange",
            RetrievalOwner::shared(),
        )
        .await
        .unwrap();

    // A model swap makes the old vector intentionally invisible to search.
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE chunks SET embedding_model = 'previous/embedder' WHERE id = 'stale'",
            [],
        )
        .unwrap();
    }
    assert!(store
        .retrieve("what is the favorite color", &RetrievalOptions::default())
        .await
        .unwrap()
        .is_empty());

    assert_eq!(store.reindex_stale_embeddings().await.unwrap(), 1);
    let hits = store
        .retrieve("what is the favorite color", &RetrievalOptions::default())
        .await
        .unwrap();
    assert_eq!(hits.first().map(|hit| hit.id.as_str()), Some("stale"));
    assert_eq!(store.reindex_stale_embeddings().await.unwrap(), 0);
}

#[tokio::test]
async fn stale_embedding_reindex_reports_progress() {
    let store = mem_store();
    for id in ["stale-a", "stale-b"] {
        store
            .index_chunk(
                id,
                ChunkSource::Memory,
                None,
                "a stale embedding fixture",
                RetrievalOwner::shared(),
            )
            .await
            .unwrap();
    }
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE chunks SET embedding_model = 'previous/embedder'",
            [],
        )
        .unwrap();
    }

    let control = StaleEmbeddingReindexControl::new();
    let outcome = store
        .reindex_stale_embeddings_with_control(&control)
        .await
        .unwrap();

    assert_eq!(outcome.updated, 2);
    assert!(!outcome.cancelled);
    assert_eq!(
        control.progress(),
        StaleEmbeddingReindexProgress {
            state: "completed".to_owned(),
            total: 2,
            processed: 2,
            updated: 2,
            error: None,
        }
    );
}

#[tokio::test]
async fn stale_embedding_reindex_honors_cancellation_before_work() {
    let store = mem_store();
    store
        .index_chunk(
            "stale",
            ChunkSource::Memory,
            None,
            "a stale embedding fixture",
            RetrievalOwner::shared(),
        )
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE chunks SET embedding_model = 'previous/embedder' WHERE id = 'stale'",
            [],
        )
        .unwrap();
    }

    let control = StaleEmbeddingReindexControl::new();
    control.cancel();
    let outcome = store
        .reindex_stale_embeddings_with_control(&control)
        .await
        .unwrap();

    assert_eq!(
        outcome,
        StaleEmbeddingReindexOutcome {
            updated: 0,
            cancelled: true,
        }
    );
    assert_eq!(control.progress().state, "cancelled");
    assert_eq!(control.progress().total, 1);
    assert_eq!(control.progress().processed, 0);
}

#[test]
fn stale_embedding_update_skips_content_changed_during_embedding() {
    let conn = Connection::open_in_memory().unwrap();
    conn.execute(
        "CREATE TABLE chunks (
            id TEXT PRIMARY KEY,
            content TEXT NOT NULL,
            embedding BLOB NOT NULL,
            embedding_model TEXT NOT NULL
        )",
        [],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO chunks (id, content, embedding, embedding_model)
         VALUES ('chunk-1', 'old text', X'00', 'old-model')",
        [],
    )
    .unwrap();

    let tx = conn.unchecked_transaction().unwrap();
    // The reindex selected `old text`, then another writer committed this
    // edit before the embedding result was ready.
    tx.execute(
        "UPDATE chunks SET content = 'new text' WHERE id = 'chunk-1'",
        [],
    )
    .unwrap();
    let cipher = ContentCipher::from_root(&[5; 32], RETRIEVAL_STORE);
    assert_eq!(
        update_stale_embedding_if_unchanged(
            &tx,
            &cipher,
            "chunk-1",
            "old text",
            &[1.0, 2.0],
            "current-model",
        )
        .unwrap(),
        0
    );
    let model: String = tx
        .query_row(
            "SELECT embedding_model FROM chunks WHERE id = 'chunk-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(model, "old-model");
}

/// AC4b: reranking genuinely changes candidate order.
///
/// Fixture design: two chunks where cosine favors C1 (token overlap with the
/// query) but Jaccard reranking favors C2 (exact term match). We force this by
/// using a query whose tokens fully cover C2 but only partially cover C1.
#[tokio::test]
async fn reranker_changes_candidate_order() {
    // C1: many tokens, partially overlapping with query.
    // C2: few tokens, all of which appear in the query.
    // Query: tokens from C2 plus one extra token that pulls cosine toward C1.
    let c1 = ScoredChunk {
        id: "c1".into(),
        source: ChunkSource::Memory,
        space_id: None,
        content: "alpha beta gamma delta epsilon zeta".into(),
        score: 0.9, // pretend cosine put c1 first
    };
    let c2 = ScoredChunk {
        id: "c2".into(),
        source: ChunkSource::Memory,
        space_id: None,
        content: "alpha beta".into(),
        score: 0.5, // cosine put c2 second
    };

    // Query: "alpha beta" — Jaccard with c2 = 2/2 = 1.0; with c1 = 2/6 ≈ 0.33.
    let query = "alpha beta";
    let reranker = Reranker::Local;
    let reranked = reranker.rerank(query, vec![c1, c2]).await.unwrap();

    // After reranking, c2 (exact match) should be first.
    assert_eq!(
        reranked[0].id, "c2",
        "reranker should elevate the exact-match chunk"
    );
    assert_eq!(reranked[1].id, "c1");
    // Scores should reflect Jaccard, not the original cosine.
    assert!(reranked[0].score > reranked[1].score);
}

/// Serve `/v1/embeddings` on loopback. Each input `text` embeds to
/// `[len(text), 1.0]`. When `accept_batches` is false an array input gets
/// HTTP 400, like a server that only takes a single string. Batched responses
/// are returned in reverse order so callers must honour `index`.
async fn spawn_embeddings_server(
    accept_batches: bool,
) -> (String, std::sync::Arc<std::sync::atomic::AtomicUsize>) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let requests = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counter = requests.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            counter.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
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
                let embed = |text: &str| serde_json::json!([text.len() as f64, 1.0]);
                let (status, response) = match &request["input"] {
                    serde_json::Value::Array(_) if !accept_batches => (
                        "400 Bad Request",
                        serde_json::json!({"error": "no batches"}),
                    ),
                    serde_json::Value::Array(inputs) => {
                        let data: Vec<_> = inputs
                            .iter()
                            .enumerate()
                            .rev()
                            .map(|(index, input)| {
                                serde_json::json!({
                                    "index": index,
                                    "embedding": embed(input.as_str().unwrap()),
                                })
                            })
                            .collect();
                        ("200 OK", serde_json::json!({ "data": data }))
                    }
                    input => (
                        "200 OK",
                        serde_json::json!({
                            "data": [{"index": 0, "embedding": embed(input.as_str().unwrap())}]
                        }),
                    ),
                };
                let payload = response.to_string();
                let reply = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
            });
        }
    });
    (format!("http://{address}"), requests)
}

/// Loopback `/v1/embeddings` that records every request body. When
/// `reject_dimensions` is set it answers any request carrying `dimensions`
/// with an OpenAI-style 400 naming the field (as `text-embedding-ada-002`
/// does). Every vector is `width` wide.
async fn spawn_recording_embeddings_server(
    reject_dimensions: bool,
    width: usize,
) -> (
    String,
    std::sync::Arc<std::sync::Mutex<Vec<serde_json::Value>>>,
) {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let recorder = seen.clone();
    tokio::spawn(async move {
        loop {
            let Ok((mut socket, _)) = listener.accept().await else {
                return;
            };
            let recorder = recorder.clone();
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
                recorder.lock().unwrap().push(request.clone());
                let vector = vec![0.5_f64; width];
                let (status, response) = if reject_dimensions && request.get("dimensions").is_some()
                {
                    (
                        "400 Bad Request",
                        serde_json::json!({"error": {
                            "message": "This model does not support specifying dimensions.",
                            "type": "invalid_request_error",
                            "param": "dimensions"
                        }}),
                    )
                } else {
                    let count = request["input"].as_array().map_or(1, Vec::len);
                    let data: Vec<_> = (0..count)
                        .map(|index| serde_json::json!({"index": index, "embedding": vector}))
                        .collect();
                    ("200 OK", serde_json::json!({ "data": data }))
                };
                let payload = response.to_string();
                let reply = format!(
                    "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
                    payload.len()
                );
                let _ = socket.write_all(reply.as_bytes()).await;
            });
        }
    });
    (format!("http://{address}"), seen)
}

#[test]
fn dimensions_parameter_only_for_matryoshka_models() {
    assert!(model_supports_dimensions("text-embedding-3-small"));
    assert!(model_supports_dimensions("openai/text-embedding-3-large"));
    assert!(!model_supports_dimensions("text-embedding-ada-002"));
    assert!(!model_supports_dimensions("nomic-embed-text"));
    assert!(!model_supports_dimensions("bge-m3"));
}

#[tokio::test]
async fn remote_embed_omits_dimensions_for_models_without_support() {
    let (base_url, seen) = spawn_recording_embeddings_server(true, 3).await;
    let embedder = Embedder::remote(&base_url, "text-embedding-ada-002", 3, None);

    let vector = embedder.embed("hello").await.expect("ada-002 embeds");
    assert_eq!(vector.len(), 3);
    let batch = embedder
        .embed_batch(&["a".to_owned(), "b".to_owned()])
        .await
        .expect("ada-002 batch embeds");
    assert_eq!(batch.len(), 2);

    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 2, "no 400 round trips: {requests:?}");
    assert!(requests
        .iter()
        .all(|request| request.get("dimensions").is_none()));
}

#[tokio::test]
async fn remote_embed_sends_dimensions_and_retries_once_without_on_rejection() {
    let (base_url, seen) = spawn_recording_embeddings_server(false, 4).await;
    Embedder::remote(&base_url, "text-embedding-3-small", 4, None)
        .embed("hello")
        .await
        .expect("v3 embeds");
    assert_eq!(seen.lock().unwrap()[0]["dimensions"], serde_json::json!(4));

    // A deployment that refuses `dimensions` even for a v3 name.
    let (base_url, seen) = spawn_recording_embeddings_server(true, 4).await;
    let vector = Embedder::remote(&base_url, "text-embedding-3-small", 4, None)
        .embed("hello")
        .await
        .expect("retry without dimensions succeeds");
    assert_eq!(vector.len(), 4);
    let requests = seen.lock().unwrap().clone();
    assert_eq!(requests.len(), 2);
    assert!(requests[0].get("dimensions").is_some());
    assert!(requests[1].get("dimensions").is_none());
}

#[tokio::test]
async fn remote_embed_rejects_width_that_does_not_match_index_dims() {
    // ada-002 returns 1536 natively; an index configured for 8 must fail
    // loudly instead of storing a mismatched vector.
    let (base_url, _seen) = spawn_recording_embeddings_server(true, 16).await;
    let embedder = Embedder::remote(&base_url, "text-embedding-ada-002", 8, None);
    let error = embedder.embed("hello").await.expect_err("width mismatch");
    assert!(error.to_string().contains("16 dimensions"), "{error:#}");
    assert!(embedder
        .embed_batch(&["a".to_owned(), "b".to_owned()])
        .await
        .is_err());
}

#[tokio::test]
async fn embed_batch_places_vectors_by_index_in_few_requests() {
    let (base_url, requests) = spawn_embeddings_server(true).await;
    let embedder = Embedder::remote(&base_url, "test-model", 2, None);
    let texts: Vec<String> = (0..(EMBED_BATCH_SIZE + 5))
        .map(|length| "x".repeat(length + 1))
        .collect();

    let vectors = embedder.embed_batch(&texts).await.expect("batched embed");

    assert_eq!(vectors.len(), texts.len());
    for (text, vector) in texts.iter().zip(&vectors) {
        assert_eq!(vector, &vec![text.len() as f32, 1.0]);
    }
    // One full batch plus a tail batch, not one request per text.
    assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst), 2);
}

#[tokio::test]
async fn embed_batch_falls_back_to_single_inputs_when_batches_are_refused() {
    let (base_url, requests) = spawn_embeddings_server(false).await;
    let embedder = Embedder::remote(&base_url, "test-model", 2, None);
    let texts = vec!["a".to_owned(), "bbb".to_owned(), "cc".to_owned()];

    let vectors = embedder.embed_batch(&texts).await.expect("fallback embed");

    assert_eq!(
        vectors,
        vec![vec![1.0, 1.0], vec![3.0, 1.0], vec![2.0, 1.0]]
    );
    // The refused batch, then one request per text.
    assert_eq!(requests.load(std::sync::atomic::Ordering::SeqCst), 4);
}

/// AC4c: embedder dims flow from the resolved config, not a hardcoded const.
/// (The registry read that produces the dims now lives in `rag_host`.)
#[test]
fn embedder_dims_from_config() {
    let embedder = Embedder::remote("http://embed.local", "test/embed", 512, None);
    assert_eq!(embedder.dims(), 512);

    // Producing a vector gives the configured length.
    let vec = local_embed("hello world", embedder.dims());
    assert_eq!(vec.len(), 512);

    // A blank base URL falls back to the local hashing embedder at the same dims.
    let local = Embedder::remote("  ", "unused", 384, None);
    assert!(local.is_local());
    assert_eq!(local.dims(), 384);
}

// ── OKF ingest ────────────────────────────────────────────────────────────

fn sample_bundle() -> ryu_knowledge::Bundle {
    let orders = ryu_knowledge::Concept::parse(
        "tables/orders.md",
        "---\ntype: BigQuery Table\ntitle: Orders\ntags:\n- sales\n---\n\
         # Schema\n\nThe orders fact table records customer purchases. \
         See [Customers](/tables/customers.md).\n",
    )
    .expect("parse orders");
    let recipe = ryu_knowledge::Concept::parse(
        "recipes/bread.md",
        "---\ntype: Playbook\ntitle: Bread\n---\n\
         Preheat the oven to 200 degrees and bake the sourdough loaf.\n",
    )
    .expect("parse recipe");
    ryu_knowledge::Bundle {
        root: std::path::PathBuf::from("/tmp/bundle"),
        concepts: vec![orders, recipe],
        index: None,
        log: None,
        okf_version: Some("0.1".to_owned()),
        warnings: Vec::new(),
    }
}

#[tokio::test]
async fn ingests_okf_bundle_and_retrieves_concept() {
    let store = mem_store();
    let summary = store
        .ingest_okf_bundle("b1", &sample_bundle(), None)
        .await
        .unwrap();
    assert_eq!(summary.concepts, 2);
    assert!(summary.chunks >= 2);

    let opts = RetrievalOptions {
        top_k: 1,
        ..Default::default()
    };
    let hits = store
        .retrieve("orders fact table customer purchases", &opts)
        .await
        .unwrap();
    assert_eq!(hits.len(), 1);
    // Indexed as a Space scoped to the bundle id.
    assert_eq!(hits[0].source, ChunkSource::Space);
    assert_eq!(hits[0].space_id.as_deref(), Some("b1"));
    assert!(hits[0].content.contains("Orders"));
}

#[tokio::test]
async fn metadata_filter_restricts_local_chunks() {
    let store = mem_store();
    for (id, lang, year) in [("a", "en", 2024), ("b", "de", 2025), ("c", "en", 2026)] {
        store
            .index_chunk_with_metadata(
                id,
                ChunkSource::Space,
                Some("kb"),
                "release notes for the widget",
                RetrievalOwner::shared(),
                Some(&serde_json::json!({ "lang": lang, "year": year })),
            )
            .await
            .unwrap();
    }
    let search = |filter: serde_json::Value| {
        let store = &store;
        async move {
            let opts = RetrievalOptions {
                top_k: 10,
                filter: Some(MetadataFilter::parse(&filter).unwrap()),
                ..Default::default()
            };
            let mut ids: Vec<String> = store
                .retrieve("widget release notes", &opts)
                .await
                .unwrap()
                .into_iter()
                .map(|c| c.id)
                .collect();
            ids.sort();
            ids
        }
    };
    assert_eq!(
        search(serde_json::json!({"lang": "en"})).await,
        vec!["a", "c"]
    );
    assert_eq!(
        search(serde_json::json!({"$or": [{"year": {"$gt": 2025}}, {"lang": "de"}]})).await,
        vec!["b", "c"]
    );
    assert_eq!(
        search(serde_json::json!({"$not": {"lang": "en"}})).await,
        vec!["b"]
    );
    // Built-in fields cannot be overridden by stored metadata.
    assert_eq!(
        search(serde_json::json!({"source": "space", "space_id": "kb", "year": {"$lt": 2025}}))
            .await,
        vec!["a"]
    );
    // Re-indexing without metadata clears it.
    store
        .index_chunk(
            "a",
            ChunkSource::Space,
            Some("kb"),
            "release notes for the widget",
            RetrievalOwner::shared(),
        )
        .await
        .unwrap();
    assert_eq!(search(serde_json::json!({"lang": "en"})).await, vec!["c"]);
}

#[tokio::test]
async fn filter_metadata_and_verbatim_okf_bodies_are_sealed_at_rest() {
    let store = mem_store();
    store
        .index_chunk_with_metadata(
            "doc-1",
            ChunkSource::Space,
            Some("kb"),
            "release notes for the widget",
            RetrievalOwner::shared(),
            Some(&serde_json::json!({ "codename": "quillfeather" })),
        )
        .await
        .unwrap();
    let long = ryu_knowledge::Concept::parse(
        "guides/setup.md",
        "---\ntype: Guide\ntitle: Setup\n---\n# Install\n\nRun the zephyrine installer.\n",
    )
    .expect("parse guide");
    let mut bundle = sample_bundle();
    bundle.concepts.push(long);
    store
        .ingest_okf_bundle_with_chunking(
            "b3",
            &bundle,
            None,
            &ChunkingStrategy::Markdown {
                chunk_size: 200,
                chunk_overlap: 0,
                include_header_path: true,
            },
        )
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        let mut stmt = conn
            .prepare("SELECT metadata FROM chunks WHERE metadata IS NOT NULL")
            .unwrap();
        let stored: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(stored.len() > 1);
        for value in &stored {
            assert!(value.starts_with("encb:v1:"), "{value}");
        }
        let mut stmt = conn
            .prepare("SELECT concept_body FROM okf_chunks WHERE concept_body IS NOT NULL")
            .unwrap();
        let bodies: Vec<String> = stmt
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(!bodies.is_empty());
        for value in &bodies {
            assert!(value.starts_with("encb:v1:"), "{value}");
        }
    }
    // Sealed metadata still drives the filter, and a sealed body still
    // exports verbatim.
    let opts = RetrievalOptions {
        top_k: 5,
        filter: Some(
            MetadataFilter::parse(&serde_json::json!({"codename": "quillfeather"})).unwrap(),
        ),
        ..Default::default()
    };
    let hits = store.retrieve("widget release notes", &opts).await.unwrap();
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert_eq!(hits[0].id, "doc-1");
    let exported = store.reconstruct_okf_concepts("b3").await.unwrap();
    let guide = exported
        .iter()
        .find(|c| c.file_path == "guides/setup.md")
        .unwrap();
    assert!(guide.body.contains("zephyrine installer"));
}

#[tokio::test]
async fn chunk_metadata_must_be_a_bounded_object() {
    let store = mem_store();
    let not_object = store
        .index_chunk_with_metadata(
            "x",
            ChunkSource::Space,
            None,
            "text",
            RetrievalOwner::shared(),
            Some(&serde_json::json!([1])),
        )
        .await;
    assert!(not_object.is_err());
    let huge = serde_json::json!({ "blob": "x".repeat(MAX_CHUNK_METADATA_BYTES) });
    assert!(store
        .index_chunk_with_metadata(
            "x",
            ChunkSource::Space,
            None,
            "text",
            RetrievalOwner::shared(),
            Some(&huge)
        )
        .await
        .is_err());
}

#[tokio::test]
async fn okf_ingest_with_a_strategy_stores_filterable_metadata_and_exports_verbatim() {
    let store = mem_store();
    let long = ryu_knowledge::Concept::parse(
        "guides/setup.md",
        &format!(
            "---\ntype: Guide\ntitle: Setup\n---\n# Install\n\n{}\n\n# Configure\n\nSet the sourdough option.\n",
            "Download the installer and run it. ".repeat(20)
        ),
    )
    .expect("parse guide");
    let original_body = long.body.clone();
    let mut bundle = sample_bundle();
    bundle.concepts.push(long);
    let summary = store
        .ingest_okf_bundle_with_chunking(
            "b2",
            &bundle,
            None,
            &ChunkingStrategy::Markdown {
                chunk_size: 200,
                chunk_overlap: 40,
                include_header_path: true,
            },
        )
        .await
        .unwrap();
    assert!(summary.chunks > 4, "{summary:?}");

    let opts = RetrievalOptions {
        top_k: 5,
        filter: Some(
            MetadataFilter::parse(&serde_json::json!({
                "okf_type": "Guide",
                "header_path": "Configure"
            }))
            .unwrap(),
        ),
        ..Default::default()
    };
    let hits = store.retrieve("sourdough option", &opts).await.unwrap();
    assert_eq!(hits.len(), 1, "{hits:?}");
    assert!(hits[0].content.contains("Configure"));

    let exported = store.reconstruct_okf_concepts("b2").await.unwrap();
    let guide = exported
        .iter()
        .find(|c| c.file_path == "guides/setup.md")
        .unwrap();
    assert_eq!(guide.body, original_body.trim());
    assert_eq!(guide.title.as_deref(), Some("Setup"));
}

#[tokio::test]
async fn okf_cross_links_are_preserved_as_edges() {
    let store = mem_store();
    store
        .ingest_okf_bundle("b1", &sample_bundle(), None)
        .await
        .unwrap();
    let edges = store.okf_links("b1").await.unwrap();
    assert!(edges
        .iter()
        .any(|e| e.concept_path == "tables/orders.md" && e.target == "/tables/customers.md"));
}

#[tokio::test]
async fn reingest_is_idempotent_on_concept_path() {
    let store = mem_store();
    let first = store
        .ingest_okf_bundle("b1", &sample_bundle(), None)
        .await
        .unwrap();
    // Re-ingesting the same bundle replaces rather than duplicates.
    let second = store
        .ingest_okf_bundle("b1", &sample_bundle(), None)
        .await
        .unwrap();
    assert_eq!(first.chunks, second.chunks);

    let edges = store.okf_links("b1").await.unwrap();
    // Exactly one edge for the cross-link, not duplicated by re-ingest.
    let customer_edges = edges
        .iter()
        .filter(|e| e.target == "/tables/customers.md")
        .count();
    assert_eq!(customer_edges, 1);
}

#[tokio::test]
async fn remove_okf_bundle_clears_chunks() {
    let store = mem_store();
    store
        .ingest_okf_bundle("b1", &sample_bundle(), None)
        .await
        .unwrap();
    let removed = store.remove_okf_bundle("b1").await.unwrap();
    assert!(removed >= 2);

    let opts = RetrievalOptions {
        top_k: 5,
        ..Default::default()
    };
    let hits = store
        .retrieve("orders fact table sourdough", &opts)
        .await
        .unwrap();
    assert!(hits.is_empty());
    // Edges gone too.
    assert!(store.okf_links("b1").await.unwrap().is_empty());
}

#[tokio::test]
async fn reconstruct_okf_concepts_round_trips_metadata_and_body() {
    let store = mem_store();
    store
        .ingest_okf_bundle("b1", &sample_bundle(), None)
        .await
        .unwrap();

    let mut concepts = store.reconstruct_okf_concepts("b1").await.unwrap();
    assert_eq!(concepts.len(), 2);
    concepts.sort_by(|a, b| a.file_path.cmp(&b.file_path));

    // recipes/bread.md sorts before tables/orders.md.
    let bread = &concepts[0];
    assert_eq!(bread.file_path, "recipes/bread.md");
    assert_eq!(bread.type_, "Playbook");
    assert_eq!(bread.title.as_deref(), Some("Bread"));
    assert!(bread.body.contains("Preheat the oven"));

    let orders = &concepts[1];
    assert_eq!(orders.file_path, "tables/orders.md");
    assert_eq!(orders.type_, "BigQuery Table");
    assert_eq!(orders.title.as_deref(), Some("Orders"));
    assert_eq!(orders.tags, vec!["sales".to_owned()]);
    assert!(orders.body.contains("orders fact table"));
    // Cross-link target survives reconstruction.
    assert!(orders
        .links
        .iter()
        .any(|l| l.target == "/tables/customers.md"));
    // Timestamp is stamped from the indexed chunk's created_at.
    assert!(orders.timestamp.is_some());

    // Unknown bundle yields no concepts (not an error).
    assert!(store
        .reconstruct_okf_concepts("nope")
        .await
        .unwrap()
        .is_empty());
}

// ── Per-caller tenancy (the content-escape filter) ────────────────────────
//
// These are the acceptance tests for the retrieval half of the Spaces/memory
// tenancy plane: `/api/retrieval/search` is where document CONTENT and
// user-scope memory actually escape (decrypted chunks), so the filter here is
// the highest-value one. They drive `retrieve()` end-to-end with a bound-node
// `RetrievalOptions` — no org registration needed, because the caller tenancy is
// passed IN (the same "pure form" trick the conversation plane's ACL uses).

/// Seed Alice's + Bob's user-scope memory and a shared node-scope fact, all with
/// the same content so cosine ranks them together — the filter, not relevance,
/// decides what each caller sees.
async fn seed_tenancy(store: &RetrievalStore) {
    let org = Some("org1");
    store
        .index_memory_chunk(
            "alice-mem",
            "the secret launch date is March",
            "user",
            None,
            "user_fact",
            3,
            RetrievalOwner::owned(Some("alice"), org, None),
        )
        .await
        .unwrap();
    store
        .index_memory_chunk(
            "bob-mem",
            "the secret launch date is March",
            "user",
            None,
            "user_fact",
            3,
            RetrievalOwner::owned(Some("bob"), org, None),
        )
        .await
        .unwrap();
    store
        .index_memory_chunk(
            "shared-node-mem",
            "the secret launch date is March",
            "node",
            None,
            "organization",
            3,
            RetrievalOwner::owned(Some("alice"), org, None),
        )
        .await
        .unwrap();
}

fn bound_opts(caller: &str) -> RetrievalOptions {
    RetrievalOptions {
        top_k: 10,
        min_score: 0.0,
        node_bound: true,
        caller_user_id: Some(caller.to_owned()),
        caller_org_id: Some("org1".to_owned()),
        ..Default::default()
    }
}

/// THE explicit content-escape test: on a bound node Bob CANNOT retrieve Alice's
/// user-scope memory, but the shared node-scope fact IS visible to him.
#[tokio::test]
async fn bob_cannot_retrieve_alices_user_memory_but_shares_node_memory() {
    let store = mem_store();
    seed_tenancy(&store).await;

    let hits = store
        .retrieve("secret launch date", &bound_opts("bob"))
        .await
        .unwrap();
    let ids: Vec<&str> = hits.iter().map(|c| c.id.as_str()).collect();
    assert!(
        !ids.contains(&"alice-mem"),
        "Bob must NOT see Alice's user-scope memory"
    );
    assert!(
        ids.contains(&"bob-mem"),
        "Bob sees his own user-scope memory"
    );
    assert!(
        ids.contains(&"shared-node-mem"),
        "node-scope memory is the shared brain, visible to Bob"
    );
}

/// No-lockout: Alice reaches her OWN user-scope memory (+ the shared fact).
#[tokio::test]
async fn alice_retrieves_her_own_user_memory() {
    let store = mem_store();
    seed_tenancy(&store).await;

    let hits = store
        .retrieve("secret launch date", &bound_opts("alice"))
        .await
        .unwrap();
    let ids: Vec<&str> = hits.iter().map(|c| c.id.as_str()).collect();
    assert!(ids.contains(&"alice-mem"));
    assert!(ids.contains(&"shared-node-mem"));
    assert!(
        !ids.contains(&"bob-mem"),
        "Alice must not see Bob's private memory"
    );
}

/// An UNBOUND node is byte-identical: no owner filtering, every chunk visible
/// regardless of who owns it (the default `node_bound = false`).
#[tokio::test]
async fn unbound_node_retrieval_is_unfiltered() {
    let store = mem_store();
    seed_tenancy(&store).await;

    let opts = RetrievalOptions {
        top_k: 10,
        ..Default::default()
    };
    let hits = store.retrieve("secret launch date", &opts).await.unwrap();
    let ids: Vec<&str> = hits.iter().map(|c| c.id.as_str()).collect();
    assert!(ids.contains(&"alice-mem"));
    assert!(ids.contains(&"bob-mem"));
    assert!(ids.contains(&"shared-node-mem"));
}

#[tokio::test]
async fn sensitive_memory_cleanup_can_be_scoped_without_a_page_limit() {
    let store = mem_store();
    for (id, owner) in [("alice-sensitive", "alice"), ("bob-sensitive", "bob")] {
        store
            .index_memory_chunk_with_metadata(
                id,
                "health condition requires a private note",
                "user",
                None,
                "user_fact",
                3,
                Some("default"),
                true,
                RetrievalOwner::owned(Some(owner), Some("org1"), None),
            )
            .await
            .unwrap();
    }

    assert_eq!(
        store
            .clear_sensitive_memory_chunks(Some("alice"))
            .await
            .unwrap(),
        1
    );
    let remaining = store.indexed_memory_ids().await.unwrap();
    assert!(!remaining.contains("alice-sensitive"));
    assert!(remaining.contains("bob-sensitive"));
}

/// `POST /api/retrieval/index` cannot take over an id it does not own: a
/// memory projection, an OKF chunk, or another member's Space chunk.
#[tokio::test]
async fn caller_space_chunk_never_replaces_rows_it_does_not_own() {
    let store = mem_store();
    let alice = || RetrievalOwner::owned(Some("alice"), Some("org1"), Some("private"));
    let bob = || RetrievalOwner::owned(Some("bob"), Some("org1"), Some("private"));
    store
        .index_chunk("mem-1", ChunkSource::Memory, None, "a fact", alice())
        .await
        .unwrap();
    store
        .index_chunk(
            "okf:bundle-1:concept#0",
            ChunkSource::Space,
            Some("bundle-1"),
            "shared knowledge",
            RetrievalOwner::owned(None, Some("org1"), Some("org")),
        )
        .await
        .unwrap();
    assert!(store
        .index_caller_space_chunk("alice-doc", None, "draft", alice())
        .await
        .unwrap());

    for id in ["mem-1", "okf:bundle-1:concept#0", "alice-doc"] {
        assert!(
            !store
                .index_caller_space_chunk(id, None, "junk", bob())
                .await
                .unwrap(),
            "bob must not replace {id}"
        );
    }
    assert!(store.indexed_memory_ids().await.unwrap().contains("mem-1"));
    let alice_hits = store.retrieve("draft", &bound_opts("alice")).await.unwrap();
    assert!(alice_hits.iter().any(|c| c.id == "alice-doc"));

    // The owner can still re-index her own id, and a fresh id is accepted.
    assert!(store
        .index_caller_space_chunk("alice-doc", None, "final", alice())
        .await
        .unwrap());
    assert!(store
        .index_caller_space_chunk("bob-doc", None, "notes", bob())
        .await
        .unwrap());
}

/// A Space chunk owned by Alice (visibility private) does not escape to Bob —
/// pins the OWNED branch of `space_tenancy_allows` on its own, independent of
/// the unowned/explicit-shared cases below.
#[tokio::test]
async fn bob_cannot_retrieve_alices_private_space_chunk_on_bound_node() {
    let store = mem_store();
    store
        .index_chunk(
            "alice-doc",
            ChunkSource::Space,
            Some("docs"),
            "quarterly revenue was forty two million",
            RetrievalOwner::owned(Some("alice"), Some("org1"), Some("private")),
        )
        .await
        .unwrap();

    let bob_hits = store
        .retrieve("quarterly revenue", &bound_opts("bob"))
        .await
        .unwrap();
    assert!(
        bob_hits.iter().all(|c| c.id != "alice-doc"),
        "Bob must not read Alice's private document chunk"
    );

    // No-lockout: Alice, the owner, still can.
    let alice_hits = store
        .retrieve("quarterly revenue", &bound_opts("alice"))
        .await
        .unwrap();
    assert!(
        alice_hits.iter().any(|c| c.id == "alice-doc"),
        "Alice must still read her own document chunk"
    );
}

/// The content-escape regression test for the fail-closed flip: a BARE unowned
/// Space chunk (no `owner_user_id`, no matching explicit org/team stamp — a
/// pre-tenancy legacy row) is now HIDDEN on a bound node rather than the old
/// fail-open "unowned = shared" default.
#[tokio::test]
async fn unowned_space_chunk_is_hidden_on_bound_node() {
    let store = mem_store();
    store
        .index_chunk(
            "legacy-bare",
            ChunkSource::Space,
            Some("docs"),
            "quarterly revenue reporting standards overview",
            RetrievalOwner::shared(),
        )
        .await
        .unwrap();

    let hits = store
        .retrieve("quarterly revenue reporting", &bound_opts("bob"))
        .await
        .unwrap();
    assert!(
        hits.iter().all(|c| c.id != "legacy-bare"),
        "a bare-unowned Space chunk must be hidden on a bound node, not shared"
    );
}

/// OKF-style content stamped with an EXPLICIT org-shared visibility (the exact
/// shape `RetrievalStore::ingest_okf_bundle` now writes: no specific user
/// owner, `owner_org_id` + `visibility = "org"`) stays visible to every member
/// of that org — this is how genuinely shared knowledge survives the
/// fail-closed flip above.
#[tokio::test]
async fn explicit_shared_space_chunk_visible_to_all_members() {
    let store = mem_store();
    store
        .index_chunk(
            "okf-shared",
            ChunkSource::Space,
            Some("docs"),
            "quarterly revenue reporting standards overview",
            RetrievalOwner::owned(None, Some("org1"), Some("org")),
        )
        .await
        .unwrap();

    let hits = store
        .retrieve("quarterly revenue reporting", &bound_opts("bob"))
        .await
        .unwrap();
    assert!(
        hits.iter().any(|c| c.id == "okf-shared"),
        "explicitly org-shared knowledge stays visible to every member"
    );
}

/// UNBOUND node: Space tenancy stays a total no-op, byte-identical regardless
/// of owner shape — including the bare-unowned case that is hidden when bound.
#[tokio::test]
async fn unbound_node_space_tenancy_noop() {
    let store = mem_store();
    store
        .index_chunk(
            "legacy-bare",
            ChunkSource::Space,
            Some("docs"),
            "quarterly revenue reporting standards overview",
            RetrievalOwner::shared(),
        )
        .await
        .unwrap();
    store
        .index_chunk(
            "alice-doc",
            ChunkSource::Space,
            Some("docs"),
            "quarterly revenue was forty two million",
            RetrievalOwner::owned(Some("alice"), Some("org1"), Some("private")),
        )
        .await
        .unwrap();

    let opts = RetrievalOptions {
        top_k: 10,
        ..Default::default()
    };
    let hits = store.retrieve("quarterly revenue", &opts).await.unwrap();
    let ids: Vec<&str> = hits.iter().map(|c| c.id.as_str()).collect();
    assert!(ids.contains(&"legacy-bare"));
    assert!(ids.contains(&"alice-doc"));
}

/// Integration: `ingest_okf_bundle` called with the node's org (the real
/// production writer, not just the pure `RetrievalOwner::owned(None, ..)`
/// shape exercised above) produces chunks that pass the fail-closed
/// `space_tenancy_allows` for every bound-node member.
#[tokio::test]
async fn okf_bundle_ingested_with_org_stays_visible_to_bound_members() {
    let store = mem_store();
    store
        .ingest_okf_bundle("b1", &sample_bundle(), Some("org1"))
        .await
        .unwrap();

    let hits = store
        .retrieve("orders fact table customer purchases", &bound_opts("bob"))
        .await
        .unwrap();
    assert!(
        !hits.is_empty(),
        "OKF content ingested with the node's org must stay visible to a bound-node member"
    );
}

/// The pure filter functions, exercised directly (no DB): the same matrix the
/// SQL-less unit tests of the conversation plane use.
#[test]
fn memory_tenancy_pure_matrix() {
    let base = RetrievableChunk {
        id: "x".into(),
        source: ChunkSource::Memory,
        space_id: None,
        content: String::new(),
        mem_scope: Some("user".into()),
        mem_scope_id: None,
        mem_agent_id: None,
        mem_importance: 3,
        mem_sensitive: false,
        mem_metadata_ready: true,
        owner_user_id: Some("alice".into()),
        owner_org_id: Some("org1".into()),
        visibility: None,
    };
    let bob = bound_opts("bob");
    let alice = bound_opts("alice");
    // user-scope: owner-only.
    assert!(!memory_tenancy_allows(&base, &bob));
    assert!(memory_tenancy_allows(&base, &alice));
    // node/project: shared.
    let node = RetrievableChunk {
        mem_scope: Some("node".into()),
        ..base.clone()
    };
    assert!(memory_tenancy_allows(&node, &bob));
    // unbound: everything.
    let unbound = RetrievalOptions::default();
    assert!(memory_tenancy_allows(&base, &unbound));

    let legacy = RetrievableChunk {
        mem_metadata_ready: false,
        ..base
    };
    assert!(
        !chunk_matches(&legacy, &RetrievalOptions::default()),
        "legacy memory metadata must fail closed while sensitive consent is off"
    );
    assert!(chunk_matches(
        &legacy,
        &RetrievalOptions {
            include_sensitive: true,
            ..Default::default()
        }
    ));
}

#[test]
fn memory_agent_and_sensitive_filters_are_independent() {
    let agent_fact = RetrievableChunk {
        mem_scope: Some("agent".into()),
        mem_scope_id: Some("agent-a".into()),
        mem_agent_id: Some("agent-a".into()),
        mem_sensitive: true,
        ..RetrievableChunk {
            id: "agent-fact".into(),
            source: ChunkSource::Memory,
            space_id: None,
            content: "health fact".into(),
            mem_scope: None,
            mem_scope_id: None,
            mem_agent_id: None,
            mem_importance: 3,
            mem_sensitive: false,
            mem_metadata_ready: true,
            owner_user_id: Some("alice".into()),
            owner_org_id: Some("org1".into()),
            visibility: None,
        }
    };
    let mut opts = RetrievalOptions {
        read_levels: Some(vec!["agent".into()]),
        agent_id: Some("agent-a".into()),
        caller_user_id: Some("alice".into()),
        node_bound: true,
        ..Default::default()
    };
    assert!(!chunk_matches(&agent_fact, &opts));
    opts.include_sensitive = true;
    assert!(chunk_matches(&agent_fact, &opts));
    opts.agent_id = Some("agent-b".into());
    assert!(!chunk_matches(&agent_fact, &opts));
}

// ── Spaces delegation (`SpaceRecall`) + rank fusion ───────────────────────
//
// What these cover, and why they exist at all: a Space's documents are NEVER
// indexed into this store (the only writers of `ChunkSource::Space` rows are
// `index_chunk` — the manual `POST /api/retrieval/index`, which no shipped
// client calls with a `space_id` — and `ingest_okf_bundle`, whose `space_id`
// is a BUNDLE id). So `space_ids` selected nothing until the delegate existed,
// and a Space's `retrieval_mode` could not reach `retrieve` at all. The fake
// below stands in for `rag_host::SpacesRecall` (which calls
// `SpaceStore::search_ext`, the same entry point the Spaces search box uses,
// so the mode branch is exercised there, not duplicated here).

/// A `SpaceRecall` that returns canned per-Space lists and counts its calls, so
/// a test can assert both WHAT was merged and WHETHER the delegate was consulted
/// at all (the `space_ids: Some([])` fast path must not touch it).
struct FakeSpaces {
    /// One ranked list per Space id, returned in `space_ids` order.
    by_space: std::collections::HashMap<String, Vec<ScoredChunk>>,
    /// Set to fail the whole resolution (the "Spaces store unavailable" case).
    fail: bool,
    /// Consultation counter. There is deliberately no accessor method: the
    /// fake is moved into the store under an `Arc<dyn SpaceRecall>`, so every
    /// test clones this handle *before* the move and reads the atomic
    /// directly. A `fn calls(&self)` would be unreachable after the move —
    /// dead code that reads as an available affordance.
    calls: Arc<std::sync::atomic::AtomicUsize>,
    /// The `per_space_limit` the store asked for on the last call.
    last_limit: Arc<std::sync::atomic::AtomicUsize>,
}

impl FakeSpaces {
    fn new(by_space: Vec<(&str, Vec<&str>)>) -> Self {
        let mut map = std::collections::HashMap::new();
        for (space, contents) in by_space {
            map.insert(
                space.to_owned(),
                contents
                    .into_iter()
                    .enumerate()
                    .map(|(i, content)| ScoredChunk {
                        id: format!("{space}:{i}"),
                        source: ChunkSource::Space,
                        space_id: Some(space.to_owned()),
                        content: content.to_owned(),
                        // Exactly what the real delegate does: no score, because
                        // a graph hit has none and a vector distance is not
                        // comparable to a cosine. Order carries the signal.
                        score: 0.0,
                    })
                    .collect(),
            );
        }
        Self {
            by_space: map,
            fail: false,
            calls: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
            last_limit: Arc::new(std::sync::atomic::AtomicUsize::new(0)),
        }
    }

    fn failing() -> Self {
        let mut s = Self::new(vec![]);
        s.fail = true;
        s
    }
}

#[async_trait::async_trait]
impl SpaceRecall for FakeSpaces {
    async fn recall(
        &self,
        _query: &str,
        opts: &RetrievalOptions,
        per_space_limit: usize,
    ) -> Result<Vec<Vec<ScoredChunk>>> {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        self.last_limit
            .store(per_space_limit, std::sync::atomic::Ordering::SeqCst);
        if self.fail {
            anyhow::bail!("spaces store unavailable");
        }
        let ids: Vec<String> = match &opts.space_ids {
            Some(ids) => ids.clone(),
            // `None` = every Space, which the real delegate enumerates under the
            // caller's tenancy filter.
            None => {
                let mut all: Vec<String> = self.by_space.keys().cloned().collect();
                all.sort();
                all
            }
        };
        Ok(ids
            .iter()
            .filter_map(|id| self.by_space.get(id).cloned())
            .filter(|l: &Vec<ScoredChunk>| !l.is_empty())
            .collect())
    }
}

fn chunk(id: &str, score: f32) -> ScoredChunk {
    ScoredChunk {
        id: id.to_owned(),
        source: ChunkSource::Memory,
        space_id: None,
        content: format!("content of {id}"),
        score,
    }
}

/// The no-op guarantee the whole design rests on: with nothing to fuse, the
/// primary list comes back **unchanged** — same order, same ids, and the same
/// cosine scores, not rank-fusion scores. Every caller that selects no Spaces
/// (and every caller predating the delegate) depends on this, including the
/// `score` field of `POST /api/retrieval/search`.
#[test]
fn fusion_without_space_lists_returns_the_primary_list_untouched() {
    let primary = vec![chunk("a", 0.9), chunk("b", 0.5), chunk("c", 0.1)];
    for others in [vec![], vec![vec![], vec![]]] {
        let out = fuse_ranked_lists(primary.clone(), others, 10);
        assert_eq!(
            out.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            ["a", "b", "c"]
        );
        let scores: Vec<f32> = out.iter().map(|c| c.score).collect();
        assert_eq!(scores, vec![0.9, 0.5, 0.1], "cosine scores must survive");
    }
}

/// Mixed retrieval: two rankings with incomparable scores interleave by RANK,
/// primary first at each rank. The graph-mode list deliberately carries the
/// constant `0.0` every graph hit has — under a naive sort by score/distance it
/// would either sink to the bottom or (sorting by distance) float every hit to
/// the top; under rank fusion its position depends only on its own ranking.
#[test]
fn fusion_interleaves_two_incomparable_rankings_by_rank() {
    let primary = vec![chunk("v0", 0.91), chunk("v1", 0.88), chunk("v2", 0.4)];
    let graph = vec![chunk("g0", 0.0), chunk("g1", 0.0), chunk("g2", 0.0)];
    let out = fuse_ranked_lists(primary, vec![graph], 6);
    assert_eq!(
        out.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["v0", "g0", "v1", "g1", "v2", "g2"]
    );
    // Scores are now fusion scores, strictly non-increasing.
    for pair in out.windows(2) {
        assert!(pair[0].score >= pair[1].score);
    }
}

/// Three lists (memory/OKF + two Spaces) keep the documented tie-break: at an
/// equal rank, the primary list wins, then the Spaces in the order the caller
/// passed them. Re-running the same fusion cannot reshuffle the injected
/// context, which is what makes a chat turn reproducible.
#[test]
fn fusion_tie_break_is_primary_then_list_order_and_is_deterministic() {
    let primary = vec![chunk("p0", 0.9), chunk("p1", 0.8)];
    let space_a = vec![chunk("a0", 0.0), chunk("a1", 0.0)];
    let space_b = vec![chunk("b0", 0.0), chunk("b1", 0.0)];
    let expected = ["p0", "a0", "b0", "p1", "a1", "b1"];
    for _ in 0..5 {
        let out = fuse_ranked_lists(primary.clone(), vec![space_a.clone(), space_b.clone()], 6);
        assert_eq!(
            out.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
            expected
        );
    }
}

/// A chunk id present in two lists is ONE output row whose contributions are
/// summed — it must not be injected twice into the model context. Reachable
/// when the same id was manually indexed here and also lives in a delegated
/// Space.
#[test]
fn fusion_dedupes_an_id_present_in_two_lists_and_sums_its_score() {
    let primary = vec![chunk("dup", 0.9), chunk("p1", 0.8)];
    let space = vec![chunk("s0", 0.0), chunk("dup", 0.0)];
    let out = fuse_ranked_lists(primary, vec![space], 10);
    assert_eq!(out.iter().filter(|c| c.id == "dup").count(), 1);
    let dup = out.iter().find(|c| c.id == "dup").unwrap();
    let solo = out.iter().find(|c| c.id == "s0").unwrap();
    assert!(
        dup.score > solo.score,
        "a chunk both sources agree on must outrank one only one source found"
    );
    assert_eq!(out[0].id, "dup");
}

/// `top_k` bounds the MERGED ranking, not each list.
#[test]
fn fusion_truncates_the_merged_ranking_to_top_k() {
    let primary = vec![chunk("v0", 0.9), chunk("v1", 0.8)];
    let space = vec![chunk("g0", 0.0), chunk("g1", 0.0)];
    let out = fuse_ranked_lists(primary, vec![space], 3);
    assert_eq!(
        out.iter().map(|c| c.id.as_str()).collect::<Vec<_>>(),
        ["v0", "g0", "v1"]
    );
}

/// **The defect this unit closes.** A Space whose content lives ONLY in the
/// Spaces store (as every real Space's does) now reaches `retrieve` — the call
/// the chat turn makes — instead of returning nothing. Without the delegate the
/// same query over the same store yields memory only.
#[tokio::test]
async fn retrieve_surfaces_space_content_that_is_not_indexed_in_this_store() {
    let store = mem_store();
    seed(&store).await;
    let opts = RetrievalOptions {
        top_k: 4,
        space_ids: Some(vec!["space-graph".to_owned()]),
        ..RetrievalOptions::default()
    };

    // Before: nothing in this store carries `space_id = "space-graph"`.
    let without = store.retrieve("moss ledger", &opts).await.unwrap();
    assert!(
        !without
            .iter()
            .any(|c| c.space_id.as_deref() == Some("space-graph")),
        "precondition: a real Space id matches no row in retrieval.db"
    );

    let fake = FakeSpaces::new(vec![(
        "space-graph",
        vec!["Moss keeps the ledger", "Ledger entries for Q3"],
    )]);
    let calls = Arc::clone(&fake.calls);
    let with = store
        .clone()
        .with_space_recall(Arc::new(fake))
        .retrieve("moss ledger", &opts)
        .await
        .unwrap();
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(with
        .iter()
        .any(|c| c.space_id.as_deref() == Some("space-graph")));
    assert!(
        with.iter().any(|c| c.source == ChunkSource::Memory),
        "the memory half must still be there — delegation ADDS a source"
    );
}

/// The default agent allowlist is `Some([])` ("no Spaces"), which is the
/// overwhelming majority of chat turns. It must not touch the Spaces store at
/// all: `spaces.db` is served by ONE connection behind one mutex that a graph
/// rebuild can hold for minutes, so a per-turn call there would be a real cost.
#[tokio::test]
async fn retrieve_with_an_empty_space_allowlist_never_calls_the_delegate() {
    let store = mem_store();
    seed(&store).await;
    let fake = FakeSpaces::new(vec![("space-graph", vec!["Moss keeps the ledger"])]);
    let calls = Arc::clone(&fake.calls);
    let store = store.with_space_recall(Arc::new(fake));
    let opts = RetrievalOptions {
        top_k: 4,
        space_ids: Some(Vec::new()),
        ..RetrievalOptions::default()
    };
    let hits = store.retrieve("dark mode", &opts).await.unwrap();
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 0);
    assert!(hits.iter().all(|c| c.source == ChunkSource::Memory));
    // …and the scores are still cosines, because nothing was fused.
    assert!(hits.iter().any(|c| c.score > 0.05));
}

/// `space_ids: None` means "all Spaces" and must reach the delegate too —
/// treating it as "no Spaces" would reinstate the defect for the one caller
/// that asks for everything.
#[tokio::test]
async fn retrieve_with_no_space_filter_delegates_every_space() {
    let store = mem_store();
    seed(&store).await;
    let fake = FakeSpaces::new(vec![
        ("space-a", vec!["Alpha space content"]),
        ("space-b", vec!["Beta space content"]),
    ]);
    let calls = Arc::clone(&fake.calls);
    let hits = store
        .with_space_recall(Arc::new(fake))
        .retrieve(
            "content",
            &RetrievalOptions {
                top_k: 8,
                space_ids: None,
                ..RetrievalOptions::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    for space in ["space-a", "space-b"] {
        assert!(
            hits.iter().any(|c| c.space_id.as_deref() == Some(space)),
            "missing {space}"
        );
    }
}

/// A Spaces store that cannot answer degrades to the `retrieval.db` half with a
/// warning — it does not fail the turn. Safe precisely because this store holds
/// no rows for a real Space, so "continue without Spaces" can never silently
/// answer a graph-mode Space with stale vector hits.
#[tokio::test]
async fn retrieve_survives_a_failing_spaces_delegate() {
    let store = mem_store();
    seed(&store).await;
    let hits = store
        .with_space_recall(Arc::new(FakeSpaces::failing()))
        .retrieve(
            "dark mode",
            &RetrievalOptions {
                top_k: 4,
                space_ids: Some(vec!["space-graph".to_owned()]),
                ..RetrievalOptions::default()
            },
        )
        .await
        .unwrap();
    assert!(hits.iter().any(|c| c.source == ChunkSource::Memory));
}

/// `min_score` thresholds THIS store's cosine-scored chunks and cannot threshold
/// a delegated Space hit (which has no comparable score — none at all in graph
/// mode). Asserted rather than left implicit, because the field is settable
/// through `POST /api/retrieval/search` and a reader would otherwise assume it
/// covers the whole result set. See the field doc for why the alternative
/// (suppressing Spaces entirely) was rejected.
#[tokio::test]
async fn min_score_filters_local_chunks_only_never_delegated_space_hits() {
    let store = mem_store();
    seed(&store).await;
    let fake = FakeSpaces::new(vec![("space-graph", vec!["Moss keeps the ledger"])]);
    let hits = store
        .with_space_recall(Arc::new(fake))
        .retrieve(
            "moss ledger",
            &RetrievalOptions {
                top_k: 5,
                space_ids: Some(vec!["space-graph".to_owned()]),
                // Above any cosine the local hashing embedder produces, so the
                // local half is emptied.
                min_score: 0.999,
                ..RetrievalOptions::default()
            },
        )
        .await
        .unwrap();
    assert!(
        hits.iter()
            .all(|c| c.space_id.as_deref() == Some("space-graph")),
        "local chunks must be thresholded away: {hits:?}"
    );
    assert!(!hits.is_empty(), "delegated Space hits pass the threshold");
}

/// The per-Space budget handed to the delegate is `top_k`: each Space may fill
/// the whole budget and the fusion truncates the merged ranking. A smaller
/// per-Space limit would silently starve every Space but the first.
#[tokio::test]
async fn delegate_receives_top_k_as_the_per_space_limit() {
    let store = mem_store();
    let fake = FakeSpaces::new(vec![("space-a", vec!["a"])]);
    let last = Arc::clone(&fake.last_limit);
    store
        .with_space_recall(Arc::new(fake))
        .retrieve(
            "anything",
            &RetrievalOptions {
                top_k: 7,
                space_ids: Some(vec!["space-a".to_owned()]),
                ..RetrievalOptions::default()
            },
        )
        .await
        .unwrap();
    assert_eq!(last.load(std::sync::atomic::Ordering::SeqCst), 7);
}

/// A store whose embedder can only fail: `Embedder::Remote` pointed at a port
/// nothing listens on. No network is required for this to be a *fast* failure —
/// a loopback connect to a closed port is refused immediately, which matters
/// because this crate builds tokio without the `time` feature and therefore has
/// no timeout to fall back on.
fn store_with_a_dead_embedder() -> RetrievalStore {
    RetrievalStore::open_in_memory_with_embedder(
        Embedder::remote(
            "http://127.0.0.1:1",
            "nomic-embed-text",
            TEST_EMBED_DIMS,
            None,
        ),
        TEST_RERANKER_ID.to_owned(),
    )
    .unwrap()
}

/// **The defect: an embed-server outage killed graph recall, which needs no
/// embedding.**
///
/// `retrieve` embedded the query as its first statement and propagated with `?`,
/// so the Spaces half never ran. A graph-mode Space is answered by a BFS over
/// `graph_nodes` seeded from the query's own tokens — no vector anywhere in it —
/// yet a lazily-started `llamacpp-embed` sidecar that was not up yet took it
/// down, and the chat path swallowed the error into a `warn!`. The user saw an
/// agent quietly stop citing its allowlisted Space.
#[tokio::test]
async fn a_dead_embedder_does_not_take_down_graph_mode_space_recall() {
    let store = store_with_a_dead_embedder();
    // Precondition: the embedder really is broken, so the assertion below is
    // about the restructure and not about a store that quietly fell back local.
    assert!(
        store
            .embedder
            .read()
            .expect("embedder lock is not poisoned")
            .embed("anything")
            .await
            .is_err(),
        "fixture broken: the embedder must fail"
    );

    let fake = FakeSpaces::new(vec![("space-graph", vec!["Moss keeps the ledger"])]);
    let calls = Arc::clone(&fake.calls);
    let hits = store
        .with_space_recall(Arc::new(fake))
        .retrieve(
            "moss ledger",
            &RetrievalOptions {
                top_k: 4,
                space_ids: Some(vec!["space-graph".to_owned()]),
                ..RetrievalOptions::default()
            },
        )
        .await
        .expect("a graph-mode Space must still answer without an embedder");
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 1);
    assert!(
        hits.iter()
            .all(|c| c.space_id.as_deref() == Some("space-graph")),
        "only the Spaces half can survive: every local hit is cosine-scored \
         against a vector that does not exist; got {hits:?}"
    );
    assert!(!hits.is_empty());
}

/// **The other half of the contract: the failure stays diagnosable.**
///
/// "Degrade to the Spaces half" must not become "swallow the outage". With
/// nothing to salvage — no delegate wired here, which is also the `space_ids:
/// Some([])` shape of the ordinary chat turn — the embedder's own error
/// propagates, exactly as it did before. An `Ok(vec![])` here would be
/// indistinguishable from "nothing was relevant" to every caller, including the
/// auto-recall path that logs and continues.
#[tokio::test]
async fn a_dead_embedder_still_errors_when_no_space_can_answer() {
    let store = store_with_a_dead_embedder();
    let err = store
        .retrieve(
            "moss ledger",
            &RetrievalOptions {
                top_k: 4,
                ..RetrievalOptions::default()
            },
        )
        .await
        .expect_err("with no Space to answer, the embedder error must surface");
    let rendered = format!("{err:#}");
    assert!(
        rendered.contains("embeddings request failed") || rendered.contains("embeddings"),
        "the surfaced error must still name the embedder failure; got {rendered}"
    );

    // Same when a delegate IS wired but answers nothing: an empty Spaces half is
    // not evidence that the query was answered.
    let err = store
        .with_space_recall(Arc::new(FakeSpaces::failing()))
        .retrieve(
            "moss ledger",
            &RetrievalOptions {
                top_k: 4,
                space_ids: Some(vec!["space-graph".to_owned()]),
                ..RetrievalOptions::default()
            },
        )
        .await;
    assert!(
        err.is_err(),
        "an empty Spaces half must not mask the outage"
    );
}

/// **The degraded path must stay diagnosable through `Display`, not only `{:#}`.**
///
/// The test above renders with `{err:#}`, which walks an `anyhow` chain — so it
/// passes whether the sidecar error is the cause of a context wrapper or is
/// formatted into the message. The two production callers do NOT agree on that
/// form: chat auto-recall logs `{e:#}`, but `POST /api/retrieval/search`
/// (`server::mod`) answers `500` with `e.to_string()`, i.e. plain `Display`.
///
/// With `local_err.context(…)`, `to_string()` yields the context string ALONE and
/// the embed/rerank failure never reaches the HTTP body — an operator gets a
/// sentence naming no service, which is strictly less than the raw sidecar error
/// the route returned before the degraded path existed. That is the whole reason
/// [`RetrievalStore::spaces_only`] formats the cause in instead.
///
/// Asserted on `to_string()` specifically (not `{:#}`) because that is the exact
/// call the route makes; a future "tidy-up" to `.context(…)` fails here.
#[tokio::test]
async fn the_degraded_path_names_the_dead_sidecar_in_plain_display() {
    let store = store_with_a_dead_embedder();
    let err = store
        .retrieve(
            "moss ledger",
            &RetrievalOptions {
                top_k: 4,
                ..RetrievalOptions::default()
            },
        )
        .await
        .expect_err("with no Space to answer, the embedder error must surface");

    let plain = err.to_string();
    assert!(
        plain.contains("embeddings"),
        "`e.to_string()` is what POST /api/retrieval/search puts in the 500 body; \
         it must still name the failing sidecar, got {plain}"
    );
    assert!(
        plain.contains("no Space answered"),
        "…and must keep the framing that says why the local half is missing, \
         got {plain}"
    );
}

/// **The same defect, one sidecar over.** The rerank pass also propagated with a
/// bare `?`, and `Reranker::Remote` is not an exotic configuration: every
/// non-release `RYU_PROFILE` seeds `RYU_RERANKER_BASE_URL`, so on a dev stack the
/// remote cross-encoder is the default and its `llamacpp-rerank` sidecar is
/// started lazily. A graph-mode Space calls neither the embedder nor this
/// reranker, so neither outage may cost it.
///
/// The local list is still dropped rather than returned in cosine order — that
/// restraint is the pre-existing behaviour and is deliberate (see
/// `RetrievalStore::spaces_only`); the only thing that changes is that
/// the Spaces half survives.
#[tokio::test]
async fn a_dead_reranker_does_not_take_down_graph_mode_space_recall() {
    let store = RetrievalStore {
        reranker: Reranker::remote("http://127.0.0.1:1", "bge-reranker", None),
        ..mem_store()
    };
    seed(&store).await;
    // Precondition: the reranker really is remote-and-broken, so this test is
    // about the restructure and not about a store that quietly stayed local.
    assert!(
        store
            .reranker
            .rerank("anything", vec![chunk("a", 0.5)])
            .await
            .is_err(),
        "fixture broken: the reranker must fail"
    );

    let fake = FakeSpaces::new(vec![("space-graph", vec!["Moss keeps the ledger"])]);
    let hits = store
        .clone()
        .with_space_recall(Arc::new(fake))
        .retrieve(
            "moss ledger",
            &RetrievalOptions {
                top_k: 4,
                space_ids: Some(vec!["space-graph".to_owned()]),
                ..RetrievalOptions::default()
            },
        )
        .await
        .expect("a graph-mode Space must still answer without a reranker");
    assert!(
        hits.iter()
            .all(|c| c.space_id.as_deref() == Some("space-graph")),
        "got {hits:?}"
    );
    assert!(!hits.is_empty());

    // …and with nothing to salvage, the reranker error still surfaces.
    assert!(
        store
            .retrieve(
                "moss ledger",
                &RetrievalOptions {
                    top_k: 4,
                    ..RetrievalOptions::default()
                },
            )
            .await
            .is_err(),
        "a rerank outage with no Space to answer must not become an empty result"
    );
}
