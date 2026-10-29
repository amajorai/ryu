//! Sealing tests for `spaces.db` and the blob store: bytes on disk are not
//! plaintext, legacy plaintext still reads and is migrated (idempotently),
//! values are bound to their rows, blind lookups keep their semantics, and
//! sealed blobs support verified range reads.

use std::path::{Path, PathBuf};

use rusqlite::{params, OptionalExtension};
use ryu_crypto::content_sqlite;
use ryu_rag::{Embedder, Reranker};

use super::*;

const TITLE: &str = "Quarterly Zanzibar Forecast";
const BODY: &str = "The marmalade pipeline ships on Thursday. See [[Budget Plan]].";
const SPACE_NAME: &str = "Private Kumquat Research";

fn keys() -> SpacesKeys {
    SpacesKeys::from_root(&[42; 32])
}

fn open_file_store(dir: &Path, keys: SpacesKeys) -> SpaceStore {
    SpaceStore::open_at_with_keys(
        dir.join("spaces.db"),
        Embedder::Local {
            dims: DEFAULT_EMBED_DIMS,
        },
        DEFAULT_EMBED_DIMS,
        DEFAULT_GRAPH_EXTRACTION_MODEL.to_owned(),
        Reranker::Local,
        dir.join("blobs"),
        None,
        keys,
    )
    .unwrap()
}

/// The database file and its WAL, concatenated.
fn db_bytes(dir: &Path) -> Vec<u8> {
    let mut bytes = std::fs::read(dir.join("spaces.db")).unwrap_or_default();
    bytes.extend(std::fs::read(dir.join("spaces.db-wal")).unwrap_or_default());
    bytes
}

fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle.as_bytes())
}

/// Checkpoint the WAL so the main file holds every page.
async fn checkpoint(store: &SpaceStore) {
    let conn = store.conn.lock().await;
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
        .unwrap();
}

fn files_under(root: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for shard in std::fs::read_dir(root).into_iter().flatten().flatten() {
        for entry in std::fs::read_dir(shard.path())
            .into_iter()
            .flatten()
            .flatten()
        {
            out.push(entry.path());
        }
    }
    out
}

#[tokio::test]
async fn text_columns_are_sealed_on_disk_and_read_back() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_file_store(dir.path(), keys());
    let owner = DocOwner::unattributed();
    let space = store
        .create_space(SPACE_NAME, Some("Mandarin orchard notes"), &owner)
        .await
        .unwrap();
    let doc = store
        .ingest_document(&space, TITLE, BODY, &owner)
        .await
        .unwrap();
    checkpoint(&store).await;

    let bytes = db_bytes(dir.path());
    for secret in [
        TITLE,
        "marmalade",
        "Budget Plan",
        "Kumquat",
        "Mandarin",
        "zanzibar",
    ] {
        assert!(
            !contains(&bytes, secret),
            "{secret:?} is on disk in plaintext"
        );
    }
    assert!(contains(&bytes, "encb:v1:"));

    let read = store.get_document(&doc).await.unwrap().unwrap();
    assert_eq!(read.title, TITLE);
    assert_eq!(read.source, BODY);
    let spaces = store.list_spaces(DocFilter::unrestricted()).await.unwrap();
    assert_eq!(spaces[0].name, SPACE_NAME);
    assert_eq!(
        spaces[0].description.as_deref(),
        Some("Mandarin orchard notes")
    );
}

#[tokio::test]
async fn a_value_moved_to_another_row_does_not_open_and_lists_skip_it() {
    let store = SpaceStore::open_in_memory_with_keys(keys()).unwrap();
    let owner = DocOwner::unattributed();
    let space = store.create_space("S", None, &owner).await.unwrap();
    let first = store.create_page(&space, "First", &owner).await.unwrap();
    let second = store.create_page(&space, "Second", &owner).await.unwrap();
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE documents SET title = (SELECT title FROM documents WHERE id = ?1)
             WHERE id = ?2",
            params![first, second],
        )
        .unwrap();
    }
    // Get-by-id: a value that does not open is an error, never empty.
    assert!(store.get_document(&second).await.is_err());
    // Lists skip the row and count it.
    let docs = store
        .list_documents(&space, DocFilter::unrestricted())
        .await
        .unwrap();
    assert_eq!(docs.len(), 1);
    assert_eq!(docs[0].id, first);
    assert!(store.seal_status().unreadable_rows >= 1);
}

#[tokio::test]
async fn a_store_sealed_under_another_key_refuses_writes() {
    let dir = tempfile::tempdir().unwrap();
    {
        let store = open_file_store(dir.path(), keys());
        store
            .create_space("Mine", None, &DocOwner::unattributed())
            .await
            .unwrap();
    }
    let other = open_file_store(dir.path(), SpacesKeys::from_root(&[9; 32]));
    assert!(!other.seal_status().writable);
    assert!(other
        .create_space("Theirs", None, &DocOwner::unattributed())
        .await
        .is_err());
}

/// Build a pre-sealing `spaces.db`: the original tables with plaintext rows,
/// a plaintext graph and a `vec0` vector table.
async fn write_legacy_db(path: &Path) -> (String, String, String) {
    let space_id = "legacy-space".to_owned();
    let doc_id = "legacy-doc".to_owned();
    let target_id = "legacy-target".to_owned();
    let conn = open_vec_connection(path).unwrap();
    conn.execute_batch(&format!(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE spaces (id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT,
             created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
             retrieval_mode TEXT NOT NULL DEFAULT 'vector');
         CREATE TABLE documents (id TEXT PRIMARY KEY,
             space_id TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
             title TEXT NOT NULL, created_at INTEGER NOT NULL,
             source TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL DEFAULT 0,
             kind TEXT NOT NULL DEFAULT 'page', parent_id TEXT);
         CREATE TABLE chunks (id TEXT PRIMARY KEY,
             document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
             space_id TEXT NOT NULL, ordinal INTEGER NOT NULL, content TEXT NOT NULL,
             created_at INTEGER NOT NULL, embed_model TEXT NOT NULL DEFAULT '',
             embed_dims INTEGER NOT NULL DEFAULT 0);
         CREATE TABLE graph_nodes (id TEXT PRIMARY KEY, space_id TEXT NOT NULL,
             entity TEXT NOT NULL, chunk_id TEXT NOT NULL);
         CREATE TABLE graph_edges (id TEXT PRIMARY KEY, space_id TEXT NOT NULL,
             src_entity TEXT NOT NULL, dst_entity TEXT NOT NULL, chunk_id TEXT NOT NULL);
         CREATE TABLE document_links (id TEXT PRIMARY KEY, space_id TEXT NOT NULL,
             src_doc_id TEXT NOT NULL, dst_doc_id TEXT, dst_title TEXT NOT NULL,
             link_kind TEXT NOT NULL DEFAULT 'wiki', created_at INTEGER NOT NULL);
         CREATE INDEX idx_document_links_title
             ON document_links(space_id, dst_title COLLATE NOCASE);
         CREATE VIRTUAL TABLE chunk_vectors
             USING vec0(rowid INTEGER PRIMARY KEY, embedding float[{DEFAULT_EMBED_DIMS}]);"
    ))
    .unwrap();
    conn.execute(
        "INSERT INTO spaces (id, name, description, created_at, updated_at)
         VALUES (?1, ?2, 'legacy description', 1, 1)",
        params![space_id, SPACE_NAME],
    )
    .unwrap();
    for (id, title, body) in [
        (&doc_id, TITLE, BODY),
        (&target_id, "Budget Plan", "Numbers for the plan."),
    ] {
        conn.execute(
            "INSERT INTO documents (id, space_id, title, created_at, source, updated_at)
             VALUES (?1, ?2, ?3, 1, ?4, 1)",
            params![id, space_id, title, body],
        )
        .unwrap();
    }
    conn.execute(
        "INSERT INTO document_links (id, space_id, src_doc_id, dst_doc_id, dst_title, created_at)
         VALUES ('legacy-link', ?1, ?2, ?3, 'Budget Plan', 1)",
        params![space_id, doc_id, target_id],
    )
    .unwrap();
    let embedder = Embedder::Local {
        dims: DEFAULT_EMBED_DIMS,
    };
    let vector = embedder.embed(BODY).await.unwrap();
    conn.execute(
        "INSERT INTO chunks (id, document_id, space_id, ordinal, content, created_at,
                             embed_model, embed_dims)
         VALUES ('legacy-chunk', ?1, ?2, 0, ?3, 1, ?4, ?5)",
        params![
            doc_id,
            space_id,
            BODY,
            embedder.model_id(),
            DEFAULT_EMBED_DIMS as i64
        ],
    )
    .unwrap();
    let rowid = conn.last_insert_rowid();
    conn.execute(
        "INSERT INTO chunk_vectors (rowid, embedding) VALUES (?1, ?2)",
        params![rowid, vec_to_bytes(&vector)],
    )
    .unwrap();
    conn.execute(
        "INSERT INTO graph_nodes (id, space_id, entity, chunk_id)
         VALUES ('legacy-node', ?1, 'marmalade', 'legacy-chunk')",
        params![space_id],
    )
    .unwrap();
    (space_id, doc_id, target_id)
}

#[tokio::test]
async fn legacy_plaintext_reads_then_migrates_once_and_leaves_no_plaintext() {
    let dir = tempfile::tempdir().unwrap();
    let (space, doc, target) = write_legacy_db(&dir.path().join("spaces.db")).await;
    let store = open_file_store(dir.path(), keys());

    // Legacy plaintext reads before the migration runs.
    let read = store.get_document(&doc).await.unwrap().unwrap();
    assert_eq!((read.title.as_str(), read.source.as_str()), (TITLE, BODY));
    let backlinks = store
        .get_backlinks(&target, DocFilter::unrestricted())
        .await
        .unwrap();
    assert_eq!(backlinks.len(), 1);
    assert_eq!(backlinks[0].src_doc_id, doc);

    let first = store.migrate_now().unwrap();
    assert!(first.sealed > 0, "legacy values must be sealed: {first:?}");
    let second = store.migrate_now().unwrap();
    assert_eq!(
        second.sealed, 0,
        "a second run must change nothing: {second:?}"
    );

    // Every sealed column opens after the migration.
    {
        let conn = store.conn.lock().await;
        content_sqlite::assert_all_open(
            &conn,
            &store.seal.keys.cipher,
            &seal::seal_plans().unwrap(),
        )
        .unwrap();
        let legacy_vec0: Option<i64> = conn
            .query_row(
                "SELECT 1 FROM sqlite_master WHERE name = 'chunk_vectors'",
                [],
                |row| row.get(0),
            )
            .optional()
            .unwrap();
        assert!(legacy_vec0.is_none(), "the plaintext vec0 table is dropped");
        // Graph rows become blind tokens; this legacy Space is in vector mode,
        // so its stray row (never read) is removed by the graph-format pass.
        let plaintext: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM graph_nodes WHERE entity NOT LIKE 'bi1:%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(plaintext, 0, "graph entities become blind tokens");
    }
    checkpoint(&store).await;
    let bytes = db_bytes(dir.path());
    for secret in [
        TITLE,
        "marmalade",
        "Budget Plan",
        "Kumquat",
        "legacy description",
    ] {
        assert!(
            !contains(&bytes, secret),
            "{secret:?} survived the migration"
        );
    }

    // Still readable and searchable after sealing.
    let read = store.get_document(&doc).await.unwrap().unwrap();
    assert_eq!(read.source, BODY);
    let hits = store
        .search_ext(&space, BODY, 3, Some(false), DocFilter::unrestricted())
        .await
        .unwrap();
    assert_eq!(
        hits.first().map(|hit| hit.chunk_id.as_str()),
        Some("legacy-chunk")
    );
    let lexical = store
        .search_documents_lexical("marmalade", 10, DocFilter::unrestricted())
        .await
        .unwrap();
    assert_eq!(lexical.len(), 1);
    assert_eq!(lexical[0].document_id, doc);
}

#[tokio::test]
async fn backlinks_resolve_rename_and_unresolve_through_blind_tokens() {
    let store = SpaceStore::open_in_memory_with_keys(keys()).unwrap();
    let owner = DocOwner::unattributed();
    let space = store.create_space("Wiki", None, &owner).await.unwrap();
    let source = store.create_page(&space, "Source", &owner).await.unwrap();
    store
        .update_document(&source, "Source", "Links to [[budget plan]].")
        .await
        .unwrap();
    // Pending until a page with that title (any case) exists.
    assert!(store.get_outgoing_links(&source).await.unwrap()[0]
        .dst_doc_id
        .is_none());
    let target = store
        .create_page(&space, "Budget Plan", &owner)
        .await
        .unwrap();
    let outgoing = store.get_outgoing_links(&source).await.unwrap();
    assert_eq!(outgoing[0].dst_doc_id.as_deref(), Some(target.as_str()));
    assert_eq!(outgoing[0].dst_title, "budget plan");

    // Renaming the target unresolves the link; renaming back re-resolves it.
    store.update_document(&target, "Other", "").await.unwrap();
    assert!(store
        .get_backlinks(&target, DocFilter::unrestricted())
        .await
        .unwrap()
        .is_empty());
    store
        .update_document(&target, "BUDGET PLAN", "")
        .await
        .unwrap();
    assert_eq!(
        store
            .get_backlinks(&target, DocFilter::unrestricted())
            .await
            .unwrap()
            .len(),
        1
    );

    // The raw title is not what the index stores.
    let conn = store.conn.lock().await;
    let token: String = conn
        .query_row(
            "SELECT dst_title_bi FROM document_links WHERE src_doc_id = ?1",
            params![source],
            |row| row.get(0),
        )
        .unwrap();
    assert!(token.starts_with("bi1:"));
    assert!(!token.contains("budget"));
}

#[tokio::test]
async fn space_by_name_keeps_exact_case_semantics() {
    let store = SpaceStore::open_in_memory_with_keys(keys()).unwrap();
    let owner = DocOwner::unattributed();
    let first = store
        .ensure_named_space("Uploads", None, &owner)
        .await
        .unwrap();
    assert_eq!(
        store
            .ensure_named_space("Uploads", None, &owner)
            .await
            .unwrap(),
        first
    );
    // The old `name = ?` was case-sensitive: a different case is another Space.
    let other = store
        .ensure_named_space("uploads", None, &owner)
        .await
        .unwrap();
    assert_ne!(other, first);
    let system = store.ensure_system_space("Artifacts", None).await.unwrap();
    assert_eq!(
        store.ensure_system_space("Artifacts", None).await.unwrap(),
        system
    );
}

#[tokio::test]
async fn lexical_search_matches_titles_by_substring_and_bodies_by_word() {
    let store = SpaceStore::open_in_memory_with_keys(keys()).unwrap();
    let owner = DocOwner::unattributed();
    let space = store.create_space("Notes", None, &owner).await.unwrap();
    let exact = store.create_page(&space, "Pipeline", &owner).await.unwrap();
    let body = store
        .ingest_document(&space, "Weekly", "the marmalade pipeline ships", &owner)
        .await
        .unwrap();

    // Title: case-insensitive substring; an exact title ranks first.
    let hits = store
        .search_documents_lexical("pipeline", 10, DocFilter::unrestricted())
        .await
        .unwrap();
    let ids: Vec<&str> = hits.iter().map(|hit| hit.document_id.as_str()).collect();
    assert_eq!(ids, vec![exact.as_str(), body.as_str()]);
    let partial = store
        .search_documents_lexical("ipel", 10, DocFilter::unrestricted())
        .await
        .unwrap();
    assert_eq!(partial.len(), 1, "title substring still matches");
    assert_eq!(partial[0].document_id, exact);

    // Body: whole words only, with a snippet from the opened body.
    let word = store
        .search_documents_lexical("MARMALADE", 10, DocFilter::unrestricted())
        .await
        .unwrap();
    assert_eq!(word.len(), 1);
    assert_eq!(word[0].document_id, body);
    assert!(word[0].snippet.contains("marmalade"));
    assert!(store
        .search_documents_lexical("armalad", 10, DocFilter::unrestricted())
        .await
        .unwrap()
        .is_empty());
    // Stopword-only queries find no body.
    assert!(store
        .search_documents_lexical("the", 10, DocFilter::unrestricted())
        .await
        .unwrap()
        .is_empty());
}

#[tokio::test]
async fn embeddings_are_sealed_rows_and_search_from_memory() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_file_store(dir.path(), keys());
    let owner = DocOwner::unattributed();
    let space = store.create_space("Vectors", None, &owner).await.unwrap();
    store
        .ingest_document(&space, "A", "apples and pears", &owner)
        .await
        .unwrap();
    store
        .ingest_document(&space, "B", "routers and switches", &owner)
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        let sealed: Vec<u8> = conn
            .query_row(
                "SELECT embedding FROM chunk_embeddings LIMIT 1",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(sealed.starts_with(b"RYU-CB01"));
    }
    let hits = store
        .search_ext(
            &space,
            "routers and switches",
            1,
            Some(false),
            DocFilter::unrestricted(),
        )
        .await
        .unwrap();
    assert_eq!(hits[0].content, "routers and switches");
    assert!(store.vector_coverage().hydrated >= 2);

    // A vector moved to another chunk does not open (bound to its chunk id).
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE chunk_embeddings SET embedding =
                 (SELECT embedding FROM chunk_embeddings ORDER BY chunk_id LIMIT 1)",
            [],
        )
        .unwrap();
    }
    store.vectors.drop_partition(&space);
    store
        .search_ext(&space, "apples", 2, Some(false), DocFilter::unrestricted())
        .await
        .unwrap();
    assert!(store.seal_status().unreadable_rows >= 1);
}

fn full_hydrations(store: &SpaceStore) -> u64 {
    store
        .full_hydrations
        .load(std::sync::atomic::Ordering::Relaxed)
}

async fn top_hit(store: &SpaceStore, space: &str, query: &str) -> Vec<String> {
    store
        .search_ext(space, query, 3, Some(false), DocFilter::unrestricted())
        .await
        .unwrap()
        .into_iter()
        .map(|hit| hit.content)
        .collect()
}

/// Writes reach a hydrated partition through the vector journal: only the
/// new vectors are opened, never the whole partition again.
#[tokio::test]
async fn vector_writes_update_the_hydrated_partition_without_a_reload() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_file_store(dir.path(), keys());
    let owner = DocOwner::unattributed();
    let space = store.create_space("Journal", None, &owner).await.unwrap();
    let apples = store
        .ingest_document(&space, "A", "apples and pears", &owner)
        .await
        .unwrap();
    let routers = store
        .ingest_document(&space, "B", "routers and switches", &owner)
        .await
        .unwrap();
    assert_eq!(
        top_hit(&store, &space, "routers and switches").await[0],
        "routers and switches"
    );
    assert_eq!(full_hydrations(&store), 1);

    // An insert, a delete and an update, each followed by a search.
    store
        .ingest_document(&space, "C", "violins and cellos", &owner)
        .await
        .unwrap();
    assert_eq!(
        top_hit(&store, &space, "violins and cellos").await[0],
        "violins and cellos"
    );
    assert!(store.delete_document(&routers).await.unwrap());
    let hits = top_hit(&store, &space, "routers and switches").await;
    assert!(!hits.iter().any(|hit| hit == "routers and switches"));
    store
        .update_document(&apples, "A", "glaciers and fjords")
        .await
        .unwrap();
    assert_eq!(
        top_hit(&store, &space, "glaciers and fjords").await[0],
        "glaciers and fjords"
    );
    assert_eq!(
        full_hydrations(&store),
        1,
        "writes never reload the partition"
    );
    assert_eq!(store.vector_coverage().hydrated, 2);
    {
        let conn = store.conn.lock().await;
        let pending: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM temp.space_vector_journal",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(pending, 0, "an applied journal is cleared");
    }

    // A generation bump the journal does not account for (another
    // connection's write) reloads the partition.
    {
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE space_vector_gen SET gen = gen + 1 WHERE space_id = ?1",
            params![space],
        )
        .unwrap();
    }
    assert_eq!(
        top_hit(&store, &space, "violins and cellos").await[0],
        "violins and cellos"
    );
    assert_eq!(full_hydrations(&store), 2);
}

async fn journal_rows(store: &SpaceStore, space: &str) -> i64 {
    let conn = store.conn.lock().await;
    conn.query_row(
        "SELECT COUNT(*) FROM temp.space_vector_journal WHERE space_id = ?1",
        params![space],
        |row| row.get(0),
    )
    .unwrap()
}

/// The in-memory vector journal is bounded: the write past
/// `VECTOR_JOURNAL_APPLY_MAX` drops a Space's journal and stops journaling
/// it, and the next search reloads the partition once.
#[tokio::test]
async fn the_vector_journal_stays_bounded_past_the_apply_limit() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_file_store(dir.path(), keys());
    let owner = DocOwner::unattributed();
    let space = store.create_space("Busy", None, &owner).await.unwrap();
    store
        .ingest_document(&space, "A", "apples and pears", &owner)
        .await
        .unwrap();
    store
        .ingest_document(&space, "B", "routers and switches", &owner)
        .await
        .unwrap();
    top_hit(&store, &space, "routers and switches").await;
    assert_eq!(full_hydrations(&store), 1);

    // Each pass rewrites both vectors: 2 journaled writes.
    let mut most = 0;
    for _ in 0..(crate::VECTOR_JOURNAL_APPLY_MAX / 2 + 500) {
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "UPDATE chunk_embeddings SET embedding = embedding WHERE space_id = ?1",
                params![space],
            )
            .unwrap();
        }
        most = most.max(journal_rows(&store, &space).await);
    }
    assert!(
        most <= crate::VECTOR_JOURNAL_APPLY_MAX as i64,
        "journal grew to {most}"
    );
    assert_eq!(
        journal_rows(&store, &space).await,
        0,
        "an overflowed journal is dropped and no longer written"
    );

    assert_eq!(
        top_hit(&store, &space, "routers and switches").await[0],
        "routers and switches"
    );
    assert_eq!(full_hydrations(&store), 2, "one reload after the overflow");
    // Journaled again after the reload, and applied.
    store
        .ingest_document(&space, "C", "violins and cellos", &owner)
        .await
        .unwrap();
    assert!(journal_rows(&store, &space).await > 0);
    assert_eq!(
        top_hit(&store, &space, "violins and cellos").await[0],
        "violins and cellos"
    );
    assert_eq!(full_hydrations(&store), 2);
}

/// An evicted partition stops being journaled: the next search on any Space
/// drops its journal.
#[tokio::test]
async fn an_evicted_partition_stops_being_journaled() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_file_store(dir.path(), keys());
    let owner = DocOwner::unattributed();
    let evicted = store.create_space("Evicted", None, &owner).await.unwrap();
    let other = store.create_space("Other", None, &owner).await.unwrap();
    store
        .ingest_document(&evicted, "A", "apples and pears", &owner)
        .await
        .unwrap();
    store
        .ingest_document(&other, "B", "routers and switches", &owner)
        .await
        .unwrap();
    top_hit(&store, &evicted, "apples and pears").await;
    store.vectors.drop_partition(&evicted);
    store
        .ingest_document(&evicted, "C", "violins and cellos", &owner)
        .await
        .unwrap();
    assert!(journal_rows(&store, &evicted).await > 0);

    top_hit(&store, &other, "routers and switches").await;
    assert_eq!(journal_rows(&store, &evicted).await, 0);
    store
        .ingest_document(&evicted, "D", "glaciers and fjords", &owner)
        .await
        .unwrap();
    assert_eq!(
        journal_rows(&store, &evicted).await,
        0,
        "not journaled until it is reloaded"
    );
    assert_eq!(
        top_hit(&store, &evicted, "glaciers and fjords").await[0],
        "glaciers and fjords"
    );
}

/// A partition larger than the whole vector budget is opened once, then
/// served by the term index without opening its vectors on every query.
#[tokio::test]
async fn a_partition_over_the_budget_is_not_reopened_on_every_query() {
    let dir = tempfile::tempdir().unwrap();
    let mut store = open_file_store(dir.path(), keys());
    store.vectors = VectorIndex::with_budget(
        "spaces-budget-test",
        ryu_crypto::vector_index::VectorBudget::new(16),
    );
    let owner = DocOwner::unattributed();
    let space = store.create_space("Tiny", None, &owner).await.unwrap();
    let apples = store
        .ingest_document(&space, "A", "apples and pears", &owner)
        .await
        .unwrap();
    assert_eq!(
        top_hit(&store, &space, "apples").await[0],
        "apples and pears",
        "served by the term index"
    );
    assert_eq!(full_hydrations(&store), 1);
    top_hit(&store, &space, "pears").await;
    assert_eq!(full_hydrations(&store), 1);
    // Growing does not make it fit.
    let routers = store
        .ingest_document(&space, "B", "routers and switches", &owner)
        .await
        .unwrap();
    assert_eq!(
        top_hit(&store, &space, "routers").await[0],
        "routers and switches"
    );
    assert_eq!(full_hydrations(&store), 1);
    // Shrinking below the refused size tries again.
    assert!(store.delete_document(&apples).await.unwrap());
    assert!(store.delete_document(&routers).await.unwrap());
    top_hit(&store, &space, "apples").await;
    assert_eq!(full_hydrations(&store), 2);
}

#[tokio::test]
async fn graph_rows_hold_tokens_and_traversal_still_works() {
    let store = SpaceStore::open_in_memory_with_keys(keys()).unwrap();
    let owner = DocOwner::unattributed();
    let space = store
        .create_space_with_mode("G", None, RetrievalMode::Graph, &owner)
        .await
        .unwrap();
    store
        .ingest_document(&space, "One", "Alice works at Acme.", &owner)
        .await
        .unwrap();
    store
        .ingest_document(&space, "Two", "Acme is based in Paris.", &owner)
        .await
        .unwrap();
    let hits = store
        .graph_search(&space, "Alice", 10, &DocFilter::unrestricted())
        .await
        .unwrap();
    assert!(hits.iter().any(|hit| hit.content.contains("Paris")));
    let conn = store.conn.lock().await;
    let plaintext: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM graph_nodes WHERE entity NOT LIKE 'bi1:%'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(plaintext, 0);
}

#[tokio::test]
async fn blobs_are_sealed_files_with_verified_range_reads() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_file_store(dir.path(), keys());
    let owner = DocOwner::unattributed();
    let space = store.create_space("Files", None, &owner).await.unwrap();
    let payload: Vec<u8> = (0..200_000u32)
        .flat_map(|n| format!("secret-line-{n}\n").into_bytes())
        .collect();
    let doc = store
        .create_file(&space, "report.txt", &payload, "text/plain", &owner)
        .await
        .unwrap();
    let files = files_under(&dir.path().join("blobs"));
    assert_eq!(files.len(), 1, "no temp or plaintext copy is left behind");
    let on_disk = std::fs::read(&files[0]).unwrap();
    assert!(on_disk.starts_with(b"RYU-SF01"));
    assert!(!contains(&on_disk, "secret-line-"));

    let (_, bytes) = store.read_file_blob(&doc).await.unwrap().unwrap();
    assert_eq!(bytes, payload);

    // Range reads equal plaintext slices; the size is the plaintext size.
    let sha = sha256_hex(&payload);
    let mut reader = open_blob(
        &dir.path().join("blobs"),
        &store.seal.keys.blob_cipher,
        &sha,
    )
    .unwrap()
    .unwrap();
    assert_eq!(reader.len(), payload.len() as u64);
    for (start, len) in [(0u64, 10u64), (65_530, 20), (1_000_000, 70_000)] {
        let end = (start + len).min(payload.len() as u64) as usize;
        assert_eq!(
            reader.read_range(start, len).unwrap(),
            payload[start as usize..end]
        );
    }

    // Truncation is detected.
    let truncated = &on_disk[..on_disk.len() - 7];
    std::fs::write(&files[0], truncated).unwrap();
    assert!(store.read_file_blob(&doc).await.is_err());
}

#[tokio::test]
async fn legacy_plaintext_blobs_read_and_are_sealed_in_place() {
    let dir = tempfile::tempdir().unwrap();
    let root = dir.path().join("blobs");
    let bytes = b"legacy uploaded bytes".to_vec();
    let sha = sha256_hex(&bytes);
    std::fs::create_dir_all(blob_path(&root, &sha).parent().unwrap()).unwrap();
    std::fs::write(blob_path(&root, &sha), &bytes).unwrap();
    // A crash leftover from a sealing pass.
    std::fs::write(
        blob_path(&root, &sha).with_file_name(format!("{sha}.sealing")),
        b"partial",
    )
    .unwrap();
    let cipher = keys().blob_cipher;

    assert_eq!(
        seal::read_blob(&root, &cipher, &sha).unwrap().unwrap(),
        bytes
    );
    let report = seal_legacy_blobs(&root, &cipher, |_| {}).unwrap();
    assert_eq!((report.sealed, report.total), (1, 1));
    assert_eq!(report.removed_leftovers, 1);
    let on_disk = std::fs::read(blob_path(&root, &sha)).unwrap();
    assert!(on_disk.starts_with(b"RYU-SF01"));
    assert!(!contains(&on_disk, "legacy uploaded"));
    assert_eq!(
        seal::read_blob(&root, &cipher, &sha).unwrap().unwrap(),
        bytes
    );
    // Idempotent.
    let again = seal_legacy_blobs(&root, &cipher, |_| {}).unwrap();
    assert_eq!(again.sealed, 0);

    // A blob whose decrypted digest does not match its name is refused.
    let other = sha256_hex(b"other");
    std::fs::create_dir_all(blob_path(&root, &other).parent().unwrap()).unwrap();
    std::fs::copy(blob_path(&root, &sha), blob_path(&root, &other)).unwrap();
    assert!(seal::read_blob(&root, &cipher, &other).is_err());
}

#[tokio::test]
async fn legacy_restore_staging_files_are_removed_by_the_migration() {
    // Older builds staged restored blobs as `tempfile` files (`.tmpXXXXXX`,
    // plaintext) inside the shard; a crash left them behind.
    let dir = tempfile::tempdir().unwrap();
    let store = open_file_store(dir.path(), keys());
    let root = dir.path().join("blobs");
    let sha = sha256_hex(b"restored bytes");
    let shard = blob_path(&root, &sha).parent().unwrap().to_path_buf();
    std::fs::create_dir_all(&shard).unwrap();
    let leftover = shard.join(".tmpabc123");
    std::fs::write(&leftover, b"plaintext restore staging copy").unwrap();

    store.migrate_now().unwrap();
    assert!(
        !leftover.exists(),
        "the plaintext staging file must be deleted"
    );
    for file in files_under(&root) {
        assert!(!contains(
            &std::fs::read(file).unwrap(),
            "plaintext restore"
        ));
    }
}

#[tokio::test]
async fn backup_export_is_plaintext_and_restore_seals() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_file_store(dir.path(), keys());
    let owner = DocOwner::unattributed();
    let space = store.create_space(SPACE_NAME, None, &owner).await.unwrap();
    store
        .create_file(&space, "notes.txt", b"export me", "text/plain", &owner)
        .await
        .unwrap();
    let archive = store
        .export_backup(
            &space,
            DocFilter::unrestricted(),
            tempfile::tempfile().unwrap(),
        )
        .await
        .unwrap();

    let restore_dir = tempfile::tempdir().unwrap();
    let target = open_file_store(restore_dir.path(), keys());
    let restored = target
        .restore_backup(archive, owner.clone(), None)
        .await
        .unwrap();
    let docs = target
        .list_documents(&restored, DocFilter::unrestricted())
        .await
        .unwrap();
    let (_, bytes) = target.read_file_blob(&docs[0].id).await.unwrap().unwrap();
    assert_eq!(bytes, b"export me");
    for file in files_under(&restore_dir.path().join("blobs")) {
        let on_disk = std::fs::read(file).unwrap();
        assert!(on_disk.starts_with(b"RYU-SF01"));
    }
}

#[tokio::test]
async fn backup_of_a_space_with_an_unreadable_parent_still_restores() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_file_store(dir.path(), keys());
    let owner = DocOwner::unattributed();
    let space = store.create_space(SPACE_NAME, None, &owner).await.unwrap();
    let other = store.create_page(&space, "Other", &owner).await.unwrap();
    let parent = store.create_page(&space, "Parent", &owner).await.unwrap();
    let child = store
        .create_child_page(&space, "Child", &parent, &owner)
        .await
        .unwrap();
    {
        // Move another row's sealed title onto the parent: it no longer opens.
        let conn = store.conn.lock().await;
        conn.execute(
            "UPDATE documents SET title = (SELECT title FROM documents WHERE id = ?1)
             WHERE id = ?2",
            params![other, parent],
        )
        .unwrap();
    }
    let archive = store
        .export_backup(
            &space,
            DocFilter::unrestricted(),
            tempfile::tempfile().unwrap(),
        )
        .await
        .unwrap();

    let restore_dir = tempfile::tempdir().unwrap();
    let target = open_file_store(restore_dir.path(), keys());
    let restored = target
        .restore_backup(archive, owner.clone(), None)
        .await
        .unwrap();
    let docs = target
        .list_documents(&restored, DocFilter::unrestricted())
        .await
        .unwrap();
    let mut titles: Vec<&str> = docs.iter().map(|doc| doc.title.as_str()).collect();
    titles.sort_unstable();
    assert_eq!(titles, ["Child", "Other"]);
    let restored_child = docs.iter().find(|doc| doc.title == "Child").unwrap();
    assert_eq!(
        restored_child.parent_id, None,
        "the orphan moves to the root"
    );
    assert_ne!(restored_child.id, child);
}

#[test]
fn every_migration_plan_binds_an_explicit_id() {
    let plans = seal::seal_plans().unwrap();
    assert!(plans.len() >= 13);
}

#[tokio::test]
async fn adopting_a_new_key_rebuilds_every_blind_token() {
    let dir = tempfile::tempdir().unwrap();
    let old_root = [42u8; 32];
    let new_root = [7u8; 32];
    let owner = DocOwner::unattributed();
    let (uploads, wiki, target, source, graph) = {
        let store = open_file_store(dir.path(), SpacesKeys::from_root(&old_root));
        let uploads = store.ensure_system_space("Uploads", None).await.unwrap();
        let wiki = store.create_space("Wiki", None, &owner).await.unwrap();
        let target = store
            .create_page(&wiki, "Budget Plan", &owner)
            .await
            .unwrap();
        let source = store.create_page(&wiki, "Source", &owner).await.unwrap();
        store
            .update_document(
                &source,
                "Source",
                "The marmalade plan. See [[budget plan]].",
            )
            .await
            .unwrap();
        let graph = store
            .create_space_with_mode("G", None, RetrievalMode::Graph, &owner)
            .await
            .unwrap();
        store
            .ingest_document(&graph, "One", "Alice works at Acme.", &owner)
            .await
            .unwrap();
        store
            .ingest_document(&graph, "Two", "Acme is based in Paris.", &owner)
            .await
            .unwrap();
        (uploads, wiki, target, source, graph)
    };

    // `keys adopt`: a new current root, the old one retired.
    let store = open_file_store(
        dir.path(),
        SpacesKeys::from_root_with_retired(&new_root, &[old_root]),
    );
    assert!(store.seal_status().writable);
    // Equality tokens are current before the store serves anything.
    assert_eq!(
        store.ensure_system_space("Uploads", None).await.unwrap(),
        uploads
    );
    assert_eq!(
        store
            .get_backlinks(&target, DocFilter::unrestricted())
            .await
            .unwrap()
            .len(),
        1
    );
    // Editing the target keeps its inbound backlink.
    store
        .update_document(&target, "Budget Plan", "edited")
        .await
        .unwrap();
    assert_eq!(
        store
            .get_backlinks(&target, DocFilter::unrestricted())
            .await
            .unwrap()
            .len(),
        1
    );
    // A new link to an existing page resolves.
    let other = store.create_page(&wiki, "Other", &owner).await.unwrap();
    store
        .update_document(&other, "Other", "Also [[Budget Plan]].")
        .await
        .unwrap();
    assert_eq!(
        store
            .get_backlinks(&target, DocFilter::unrestricted())
            .await
            .unwrap()
            .len(),
        2
    );

    // The background pass rebuilds the term index and the graph.
    store.migrate_now().unwrap();
    let hits = store
        .search_documents_lexical("marmalade", 10, DocFilter::unrestricted())
        .await
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].document_id, source);
    let graph_hits = store
        .graph_search(&graph, "Alice", 10, &DocFilter::unrestricted())
        .await
        .unwrap();
    assert!(graph_hits.iter().any(|hit| hit.content.contains("Paris")));
    {
        let conn = store.conn.lock().await;
        let (kcv, state) = blind_generation(&conn).unwrap().unwrap();
        assert_eq!(state, blind_states::OK);
        assert_eq!(kcv.as_deref(), Some(store.seal.keys.cipher.kcv()));
    }

    // A third open under the new key has nothing to rebuild.
    drop(store);
    let again = open_file_store(dir.path(), SpacesKeys::from_root(&new_root));
    assert_eq!(
        again.ensure_system_space("Uploads", None).await.unwrap(),
        uploads
    );
}

#[tokio::test]
async fn term_triggers_live_on_the_connection_not_in_the_database() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_file_store(dir.path(), keys());
    let owner = DocOwner::unattributed();
    let space = store.create_space("Notes", None, &owner).await.unwrap();
    store
        .ingest_document(&space, "Weekly", "the marmalade pipeline ships", &owner)
        .await
        .unwrap();
    let persistent: i64 = {
        let conn = store.conn.lock().await;
        conn.query_row(
            "SELECT COUNT(*) FROM main.sqlite_master
             WHERE type = 'trigger' AND sql LIKE '%ryu_terms%'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(persistent, 0, "no stored trigger may call ryu_terms");
    drop(store);

    // A connection without the Spaces SQL functions (a downgraded build, the
    // sqlite3 CLI) can still write pages and chunks.
    let plain = Connection::open(dir.path().join("spaces.db")).unwrap();
    plain
        .execute(
            "UPDATE documents SET source = 'edited elsewhere' WHERE space_id = ?1",
            params![space],
        )
        .unwrap();
    plain
        .execute(
            "UPDATE chunks SET content = 'edited elsewhere' WHERE space_id = ?1",
            params![space],
        )
        .unwrap();
}

#[tokio::test]
async fn sealed_connections_keep_temp_storage_in_memory() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_file_store(dir.path(), keys());
    let mode: i64 = {
        let conn = store.conn.lock().await;
        conn.query_row("PRAGMA temp_store", [], |row| row.get(0))
            .unwrap()
    };
    assert_eq!(mode, 2, "temp_store must be MEMORY on the store connection");
    // The migration connection goes through the same setup.
    let migration = open_vec_connection(&dir.path().join("spaces.db")).unwrap();
    secure_connection(&migration).unwrap();
    let mode: i64 = migration
        .query_row("PRAGMA temp_store", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode, 2);
    store.migrate_now().unwrap();
}

#[tokio::test]
async fn deferred_compaction_runs_with_file_temp_storage_then_memory() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("spaces.db");
    {
        let store = open_file_store(dir.path(), keys());
        let owner = DocOwner::unattributed();
        let space = store.create_space(SPACE_NAME, None, &owner).await.unwrap();
        store
            .ingest_document(&space, TITLE, BODY, &owner)
            .await
            .unwrap();
        // The migration finished; only its compaction was deferred.
        store.migrate_now().unwrap();
        let conn = store.conn.lock().await;
        // A compaction a previous migration deferred (size gate).
        conn.execute(
            &format!(
                "UPDATE {} SET state = ?1, cursor = NULL WHERE store = ?2 AND item = ?3",
                content_sqlite::STATE_TABLE
            ),
            params![
                content_sqlite::states::VACUUM_PENDING,
                SPACES_STORE,
                content_sqlite::STORE_ITEM
            ],
        )
        .unwrap();
    }

    // The VACUUM's transient copy goes to file temp storage, not RAM.
    let conn = open_vec_connection(&path).unwrap();
    let during: i64 = with_file_temp_store(&conn, |conn| {
        conn.query_row("PRAGMA temp_store", [], |row| row.get(0))
            .unwrap()
    })
    .unwrap();
    assert_eq!(during, 1, "VACUUM must not run with temp_store = MEMORY");
    drop(conn);

    let store = open_file_store(dir.path(), keys());
    let conn = store.conn.lock().await;
    let record = content_sqlite::read_store_record(&conn, SPACES_STORE)
        .unwrap()
        .unwrap();
    assert_eq!(
        record.state,
        content_sqlite::states::OK,
        "the deferred compaction ran at open"
    );
    let mode: i64 = conn
        .query_row("PRAGMA temp_store", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode, 2, "sealed reads after the compaction use MEMORY");
}

/// A store too large to compact at open is compacted by the background job
/// under its own connection lock; the job restores MEMORY temp storage and the
/// TEMP term-index and vector-journal triggers the file temp store dropped.
#[tokio::test]
async fn the_background_compaction_restores_the_connection() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("spaces.db");
    let store = open_file_store(dir.path(), keys());
    let owner = DocOwner::unattributed();
    let space = store.create_space(SPACE_NAME, None, &owner).await.unwrap();
    store
        .ingest_document(&space, TITLE, BODY, &owner)
        .await
        .unwrap();
    store.migrate_now().unwrap();
    let conn = store.conn.lock().await;
    let temp_triggers = |conn: &Connection| -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM sqlite_temp_master WHERE type = 'trigger'",
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    let triggers = temp_triggers(&conn);
    // Four term-index triggers and three vector-journal triggers.
    assert_eq!(triggers, 7);
    set_store_state(&conn, content_sqlite::states::VACUUM_PENDING);
    assert!(content_sqlite::compaction_owed(&conn, SPACES_STORE).unwrap());

    assert!(SpaceStore::compact_deferred(&conn, &path).unwrap());
    assert_eq!(store_state(&conn), content_sqlite::states::OK);
    let mode: i64 = conn
        .query_row("PRAGMA temp_store", [], |row| row.get(0))
        .unwrap();
    assert_eq!(mode, 2, "sealed reads after the compaction use MEMORY");
    assert_eq!(
        temp_triggers(&conn),
        triggers,
        "term-index and vector-journal triggers reinstalled"
    );
    drop(conn);
    // The term index still follows new writes.
    let doc = store
        .ingest_document(&space, "Second page", "zebra crossing notes", &owner)
        .await
        .unwrap();
    let conn = store.conn.lock().await;
    let indexed: i64 = conn
        .query_row(
            "SELECT COUNT(*) FROM spaces_terms_map WHERE kind = 'doc' AND ref_id = ?1",
            params![doc],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(indexed, 1);
}

/// `(chunk, entity)` pairs that appear more than once in a Space's graph.
fn duplicate_graph_nodes(conn: &Connection, space: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM (SELECT 1 FROM graph_nodes WHERE space_id = ?1
                               GROUP BY chunk_id, entity HAVING COUNT(*) > 1)",
        params![space],
        |row| row.get(0),
    )
    .unwrap()
}

fn graph_node_count(conn: &Connection, space: &str) -> i64 {
    conn.query_row(
        "SELECT COUNT(*) FROM graph_nodes WHERE space_id = ?1",
        params![space],
        |row| row.get(0),
    )
    .unwrap()
}

#[tokio::test]
async fn a_graph_rebuild_after_key_adoption_is_batched_without_duplicates() {
    let dir = tempfile::tempdir().unwrap();
    let old_root = [42u8; 32];
    let new_root = [7u8; 32];
    let owner = DocOwner::unattributed();
    let graph = {
        let store = open_file_store(dir.path(), SpacesKeys::from_root(&old_root));
        let graph = store
            .create_space_with_mode("G", None, RetrievalMode::Graph, &owner)
            .await
            .unwrap();
        store
            .ingest_document(&graph, "One", "Alice works at Acme.", &owner)
            .await
            .unwrap();
        graph
    };

    let store = open_file_store(
        dir.path(),
        SpacesKeys::from_root_with_retired(&new_root, &[old_root]),
    );
    // A page written while the rebuild is owed gets its rows from the live
    // path under the new key; the rebuild must not add them a second time.
    store
        .ingest_document(&graph, "Two", "Acme is based in Paris.", &owner)
        .await
        .unwrap();
    store.migrate_now().unwrap();
    {
        let conn = store.conn.lock().await;
        assert_eq!(duplicate_graph_nodes(&conn, &graph), 0);
        assert!(graph_node_count(&conn, &graph) > 0);
        let leftover: i64 = conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM {} WHERE item LIKE 'reindex:%'",
                    content_sqlite::STATE_TABLE
                ),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(leftover, 0, "progress rows go with the final record");
    }
    let hits = store
        .graph_search(&graph, "Alice", 10, &DocFilter::unrestricted())
        .await
        .unwrap();
    assert!(hits.iter().any(|hit| hit.content.contains("Paris")));
}

#[tokio::test]
async fn a_graph_rebuild_resumes_from_its_recorded_cursor() {
    let dir = tempfile::tempdir().unwrap();
    let old_root = [42u8; 32];
    let new_root = [7u8; 32];
    let owner = DocOwner::unattributed();
    let graph = {
        let store = open_file_store(dir.path(), SpacesKeys::from_root(&old_root));
        let graph = store
            .create_space_with_mode("G", None, RetrievalMode::Graph, &owner)
            .await
            .unwrap();
        store
            .ingest_document(&graph, "One", "Alice works at Acme.", &owner)
            .await
            .unwrap();
        store
            .ingest_document(&graph, "Two", "Acme is based in Paris.", &owner)
            .await
            .unwrap();
        graph
    };
    let store = open_file_store(
        dir.path(),
        SpacesKeys::from_root_with_retired(&new_root, &[old_root]),
    );
    let kcv = store.seal.keys.cipher.kcv().to_owned();
    {
        // A previous run cleared the Space and processed its first chunk
        // before it stopped.
        let conn = store.conn.lock().await;
        conn.execute(
            "DELETE FROM graph_edges WHERE space_id = ?1",
            params![graph],
        )
        .unwrap();
        conn.execute(
            "DELETE FROM graph_nodes WHERE space_id = ?1",
            params![graph],
        )
        .unwrap();
        let first: i64 = conn
            .query_row(
                "SELECT MIN(rowid) FROM chunks WHERE space_id = ?1",
                params![graph],
                |row| row.get(0),
            )
            .unwrap();
        set_reindex_progress(
            &conn,
            &kcv,
            &format!("{REINDEX_GRAPH_ITEM_PREFIX}{graph}"),
            first,
        )
        .unwrap();
    }
    store.migrate_now().unwrap();
    let conn = store.conn.lock().await;
    let rebuilt_chunks: Vec<String> = {
        let mut stmt = conn
            .prepare("SELECT DISTINCT chunk_id FROM graph_nodes WHERE space_id = ?1")
            .unwrap();
        stmt.query_map(params![graph], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    let first_chunk: String = conn
        .query_row(
            "SELECT id FROM chunks WHERE space_id = ?1 ORDER BY rowid LIMIT 1",
            params![graph],
            |row| row.get(0),
        )
        .unwrap();
    assert!(
        !rebuilt_chunks.is_empty(),
        "chunks after the cursor are rebuilt"
    );
    assert!(
        !rebuilt_chunks.contains(&first_chunk),
        "chunks at or before the cursor are not processed again"
    );
}

#[tokio::test]
async fn history_snapshots_use_keyed_addresses_and_legacy_digests_move() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_file_store(dir.path(), keys());
    let owner = DocOwner::unattributed();
    let space = store.create_space("History", None, &owner).await.unwrap();
    let doc = store
        .ingest_document(&space, "Bank PIN", "4821", &owner)
        .await
        .unwrap();
    store
        .update_document_versioned(&doc, "Bank PIN", "9034", Some(0), Some("e1"), None)
        .await
        .unwrap();
    let versions: Vec<String> = {
        let conn = store.conn.lock().await;
        let mut stmt = conn
            .prepare("SELECT id FROM document_versions WHERE document_id = ?1")
            .unwrap();
        stmt.query_map(params![doc], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    };
    assert!(!versions.is_empty());

    // New rows are addressed by a keyed hash, never the plain digest.
    let legacy_hashes: Vec<String> = {
        let conn = store.conn.lock().await;
        let rows: Vec<(String, String, Vec<u8>)> = {
            let mut stmt = conn
                .prepare(
                    "SELECT hash, codec, ryu_open_blob('document_version_blobs.payload', hash, payload)
                     FROM document_version_blobs",
                )
                .unwrap();
            stmt.query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))
                .unwrap()
                .collect::<rusqlite::Result<_>>()
                .unwrap()
        };
        assert!(!rows.is_empty());
        let mut legacy = Vec::new();
        for (hash, codec, payload) in rows {
            assert_eq!(hash.len(), 32, "keyed address");
            let raw = history::snapshot_raw(&codec, &payload).unwrap();
            let digest = sha256_hex(&raw);
            assert_ne!(hash, digest[..32], "the address is not the plain digest");
            // Rewrite the row as an older build stored it: unkeyed digest,
            // plaintext payload.
            conn.execute(
                "INSERT INTO document_version_blobs
                     (hash, codec, payload, raw_bytes, stored_bytes, created_at)
                 SELECT ?1, codec, ?2, raw_bytes, stored_bytes, created_at
                 FROM document_version_blobs WHERE hash = ?3",
                params![digest, payload, hash],
            )
            .unwrap();
            conn.execute(
                "UPDATE document_versions SET blob_hash = ?1 WHERE blob_hash = ?2",
                params![digest, hash],
            )
            .unwrap();
            conn.execute(
                "DELETE FROM document_version_blobs WHERE hash = ?1",
                params![hash],
            )
            .unwrap();
            legacy.push(digest);
        }
        legacy
    };
    let before: Vec<String> = {
        let mut out = Vec::new();
        for version in &versions {
            let read = store.get_document_version(version).await.unwrap().unwrap();
            out.push(read.source);
        }
        out
    };

    store.migrate_now().unwrap();
    {
        let conn = store.conn.lock().await;
        let left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM document_version_blobs WHERE length(hash) != 32",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(left, 0, "every legacy digest moved to a keyed address");
        let dangling: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM document_versions v WHERE blob_hash IS NOT NULL
                 AND NOT EXISTS (SELECT 1 FROM document_version_blobs b WHERE b.hash = v.blob_hash)",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(dangling, 0);
    }
    for (version, source) in versions.iter().zip(&before) {
        let read = store.get_document_version(version).await.unwrap().unwrap();
        assert_eq!(&read.source, source);
    }
    checkpoint(&store).await;
    let bytes = db_bytes(dir.path());
    for digest in &legacy_hashes {
        assert!(
            !contains(&bytes, digest),
            "the unkeyed digest is gone from disk"
        );
    }
    // Idempotent.
    store.migrate_now().unwrap();
}

fn contains_bytes(haystack: &[u8], needle: &[u8]) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle)
}

#[tokio::test]
async fn a_plaintext_reindex_staging_table_left_by_a_failed_run_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("spaces.db");
    write_legacy_db(&path).await;
    // Builds before sealing staged an embedding reindex in a plaintext vec0
    // table and only dropped it after a successful swap.
    let staged: Vec<f32> = (0..DEFAULT_EMBED_DIMS)
        .map(|index| 4321.125 + index as f32)
        .collect();
    let staged_bytes = vec_to_bytes(&staged);
    {
        let conn = open_vec_connection(&path).unwrap();
        conn.execute_batch(&format!(
            "CREATE VIRTUAL TABLE chunk_vectors_rebuild
                 USING vec0(rowid INTEGER PRIMARY KEY, embedding float[{DEFAULT_EMBED_DIMS}]);"
        ))
        .unwrap();
        conn.execute(
            "INSERT INTO chunk_vectors_rebuild (rowid, embedding) VALUES (1, ?1)",
            params![staged_bytes],
        )
        .unwrap();
        conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))
            .unwrap();
    }
    assert!(contains_bytes(&db_bytes(dir.path()), &staged_bytes[..64]));

    let store = open_file_store(dir.path(), keys());
    store.migrate_now().unwrap();
    {
        let conn = store.conn.lock().await;
        let left: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name LIKE 'chunk_vectors_rebuild%'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(left, 0, "the staging table and its shadow tables are gone");
    }
    checkpoint(&store).await;
    assert!(
        !contains_bytes(&db_bytes(dir.path()), &staged_bytes[..64]),
        "staged plaintext vectors survived the migration"
    );
}

/// Every `spaces_terms` row's stored content, as token lists.
fn term_rows(conn: &Connection) -> Vec<Vec<String>> {
    let mut stmt = conn.prepare("SELECT c0 FROM spaces_terms_content").unwrap();
    stmt.query_map([], |row| row.get::<_, String>(0))
        .unwrap()
        .map(|row| row.unwrap().split(' ').map(str::to_owned).collect())
        .collect()
}

fn is_sorted(tokens: &[String]) -> bool {
    tokens.windows(2).all(|pair| pair[0] <= pair[1])
}

#[tokio::test]
async fn term_index_rows_are_sorted_by_token_and_legacy_rows_are_rebuilt() {
    let dir = tempfile::tempdir().unwrap();
    let owner = DocOwner::unattributed();
    let store = open_file_store(dir.path(), keys());
    let space = store.create_space("Terms", None, &owner).await.unwrap();
    let doc = store
        .ingest_document(
            &space,
            "Fruit",
            "zebra yacht xylophone walrus violin umbrella apple banana cherry",
            &owner,
        )
        .await
        .unwrap();
    {
        let conn = store.conn.lock().await;
        let rows = term_rows(&conn);
        assert!(!rows.is_empty());
        for row in &rows {
            assert!(row.len() > 1);
            assert!(is_sorted(row), "a stored row is not sorted by token");
        }
        // Simulate an index written by an earlier build: rows in another order
        // and no format record.
        conn.execute_batch(&format!(
            "UPDATE spaces_terms SET terms = 'zzzz ' || terms;
             DELETE FROM {} WHERE item = 'format:terms';",
            content_sqlite::STATE_TABLE
        ))
        .unwrap();
        assert!(term_rows(&conn).iter().any(|row| !is_sorted(row)));
    }
    store.migrate_now().unwrap();
    {
        let conn = store.conn.lock().await;
        let rows = term_rows(&conn);
        assert!(!rows.is_empty(), "the index is refilled");
        for row in &rows {
            assert!(is_sorted(row), "a rebuilt row is not sorted by token");
            assert!(!row.iter().any(|token| token == "zzzz"));
        }
    }
    let hits = store
        .search_documents_lexical("walrus", 10, DocFilter::unrestricted())
        .await
        .unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].document_id, doc);
}

#[tokio::test]
async fn deleted_pages_leave_no_term_postings_in_the_file() {
    let dir = tempfile::tempdir().unwrap();
    let owner = DocOwner::unattributed();
    let store = open_file_store(dir.path(), keys());
    let space = store.create_space("Terms", None, &owner).await.unwrap();
    store
        .ingest_document(&space, "Kept", "orchid begonia camellia delphinium", &owner)
        .await
        .unwrap();
    let kept: std::collections::HashSet<String> = {
        let conn = store.conn.lock().await;
        term_rows(&conn).into_iter().flatten().collect()
    };
    let doomed = store
        .ingest_document(&space, "Doomed", "quokka wombat numbat bilby dingo", &owner)
        .await
        .unwrap();
    let doomed_tokens: Vec<String> = {
        let conn = store.conn.lock().await;
        let all: std::collections::HashSet<String> =
            term_rows(&conn).into_iter().flatten().collect();
        all.difference(&kept).cloned().collect()
    };
    assert!(!doomed_tokens.is_empty());
    checkpoint(&store).await;
    // A token's tail: later terms of an FTS5 leaf are prefix-compressed.
    let tail = |token: &String| token[token.len() - 24..].to_owned();
    let bytes = db_bytes(dir.path());
    for token in &doomed_tokens {
        assert!(contains(&bytes, &tail(token)), "token is indexed");
    }
    assert!(store.delete_document(&doomed).await.unwrap());
    checkpoint(&store).await;
    let bytes = db_bytes(dir.path());
    for token in &doomed_tokens {
        assert!(
            !contains(&bytes, &tail(token)),
            "a deleted page's token stayed in spaces_terms"
        );
    }
    for token in &kept {
        assert!(contains(&bytes, &tail(token)), "kept tokens are untouched");
    }
}

/// The graph entities of `chunk` in row-id order.
fn graph_entities_by_id(conn: &Connection, chunk: &str) -> Vec<String> {
    let mut stmt = conn
        .prepare("SELECT entity FROM graph_nodes WHERE chunk_id = ?1 ORDER BY id")
        .unwrap();
    stmt.query_map(params![chunk], |row| row.get(0))
        .unwrap()
        .collect::<rusqlite::Result<_>>()
        .unwrap()
}

#[tokio::test]
async fn graph_rows_are_written_in_token_order_and_legacy_rows_are_rebuilt() {
    let dir = tempfile::tempdir().unwrap();
    let owner = DocOwner::unattributed();
    let store = open_file_store(dir.path(), keys());
    let space = store
        .create_space_with_mode("G", None, RetrievalMode::Graph, &owner)
        .await
        .unwrap();
    store
        .ingest_document(
            &space,
            "One",
            "Zelda met Yusuf and Xavier in Warsaw with Victor, Ursula and Alice.",
            &owner,
        )
        .await
        .unwrap();
    let chunk: String = {
        let conn = store.conn.lock().await;
        conn.query_row(
            "SELECT id FROM chunks WHERE space_id = ?1",
            params![space],
            |row| row.get(0),
        )
        .unwrap()
    };
    let before = {
        let conn = store.conn.lock().await;
        let entities = graph_entities_by_id(&conn, &chunk);
        assert!(entities.len() > 2);
        assert!(is_sorted(&entities), "graph rows must be in token order");
        // Simulate rows written by an earlier build: ids in another order and
        // no format record.
        conn.execute_batch(&format!(
            "UPDATE graph_nodes SET id = printf('%032d', 999999 - rowid);
             DELETE FROM {} WHERE item = 'format:graph';",
            content_sqlite::STATE_TABLE
        ))
        .unwrap();
        assert!(!is_sorted(&graph_entities_by_id(&conn, &chunk)));
        let mut sorted = entities;
        sorted.sort();
        sorted
    };
    store.migrate_now().unwrap();
    {
        let conn = store.conn.lock().await;
        let after = graph_entities_by_id(&conn, &chunk);
        assert!(is_sorted(&after), "rebuilt graph rows are in token order");
        let mut set = after.clone();
        set.sort();
        assert_eq!(set, before, "the rebuild keeps the same entities");
        assert_eq!(duplicate_graph_nodes(&conn, &space), 0);
    }
    let hits = store
        .graph_search(&space, "Zelda", 10, &DocFilter::unrestricted())
        .await
        .unwrap();
    assert!(!hits.is_empty());
}

fn store_state(conn: &Connection) -> String {
    content_sqlite::read_store_record(conn, SPACES_STORE)
        .unwrap()
        .unwrap()
        .state
}

fn set_store_state(conn: &Connection, state: &str) {
    conn.execute(
        &format!(
            "UPDATE {} SET state = ?1, cursor = NULL WHERE store = ?2 AND item = ?3",
            content_sqlite::STATE_TABLE
        ),
        params![state, SPACES_STORE, content_sqlite::STORE_ITEM],
    )
    .unwrap();
}

#[tokio::test]
async fn deferred_compaction_waits_until_every_value_is_sealed() {
    let dir = tempfile::tempdir().unwrap();
    let unsealed_item = seal::seal_plans().unwrap()[0].item();
    {
        let store = open_file_store(dir.path(), keys());
        let owner = DocOwner::unattributed();
        let space = store.create_space(SPACE_NAME, None, &owner).await.unwrap();
        store
            .ingest_document(&space, TITLE, BODY, &owner)
            .await
            .unwrap();
        store.migrate_now().unwrap();
        let conn = store.conn.lock().await;
        // A restart while the column pass is still working through an item:
        // the scrub is owed, but legacy plaintext may still be present.
        conn.execute(
            &format!(
                "UPDATE {} SET state = ?1 WHERE store = ?2 AND item = ?3",
                content_sqlite::STATE_TABLE
            ),
            params![content_sqlite::states::SEALING, SPACES_STORE, unsealed_item],
        )
        .unwrap();
        set_store_state(&conn, content_sqlite::states::VACUUM_PENDING);
    }

    // The open does not VACUUM (its transient copy is never scrubbed).
    let store = open_file_store(dir.path(), keys());
    {
        let conn = store.conn.lock().await;
        assert_eq!(
            store_state(&conn),
            content_sqlite::states::VACUUM_PENDING,
            "no compaction may run while an item is unsealed"
        );
    }
    // The migration seals the item, then finishes the scrub itself.
    store.migrate_now().unwrap();
    let conn = store.conn.lock().await;
    assert_eq!(
        content_sqlite::item_state(&conn, SPACES_STORE, &unsealed_item)
            .unwrap()
            .as_deref(),
        Some(content_sqlite::states::SEALED)
    );
    assert_eq!(store_state(&conn), content_sqlite::states::OK);
}

#[tokio::test]
async fn deferred_compaction_waits_for_the_legacy_vector_table_and_derived_formats() {
    let dir = tempfile::tempdir().unwrap();
    write_legacy_db(&dir.path().join("spaces.db")).await;
    {
        let store = open_file_store(dir.path(), keys());
        store.migrate_now().unwrap();
        let conn = store.conn.lock().await;
        // Pretend every column is sealed but the derived-index pass has not run.
        conn.execute(
            &format!(
                "UPDATE {} SET state = 'filling' WHERE store = ?1 AND item = ?2",
                content_sqlite::STATE_TABLE
            ),
            params![BLIND_STORE, TERMS_FORMAT_ITEM],
        )
        .unwrap();
        set_store_state(&conn, content_sqlite::states::VACUUM_PENDING);
    }
    let store = open_file_store(dir.path(), keys());
    {
        let conn = store.conn.lock().await;
        assert_eq!(store_state(&conn), content_sqlite::states::VACUUM_PENDING);
        assert!(!SpaceStore::migration_finished(&conn).unwrap());
        // With the format restored the store counts as migrated again, but a
        // leftover legacy vec0 table also blocks the compaction.
        set_derived_format(&conn, TERMS_FORMAT_ITEM, DERIVED_FORMAT_SORTED).unwrap();
        assert!(SpaceStore::migration_finished(&conn).unwrap());
        conn.execute_batch(&format!(
            "CREATE VIRTUAL TABLE chunk_vectors
                 USING vec0(rowid INTEGER PRIMARY KEY, embedding float[{DEFAULT_EMBED_DIMS}]);"
        ))
        .unwrap();
        assert!(!SpaceStore::migration_finished(&conn).unwrap());
    }
    store.migrate_now().unwrap();
    let conn = store.conn.lock().await;
    assert!(SpaceStore::migration_finished(&conn).unwrap());
    assert_eq!(store_state(&conn), content_sqlite::states::OK);
}

fn staging_schemas(conn: &Connection) -> (i64, i64) {
    let count = |schema: &str| -> i64 {
        conn.query_row(
            &format!(
                "SELECT COUNT(*) FROM {schema}
                 WHERE name IN ('retrieval_rebuild_nodes', 'retrieval_rebuild_edges')"
            ),
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    (count("main.sqlite_master"), count("temp.sqlite_master"))
}

#[tokio::test]
async fn graph_mode_staging_tables_live_in_the_main_schema() {
    let dir = tempfile::tempdir().unwrap();
    let store = open_file_store(dir.path(), keys());
    let owner = DocOwner::unattributed();
    let space = store.create_space(SPACE_NAME, None, &owner).await.unwrap();
    store
        .ingest_document(&space, TITLE, BODY, &owner)
        .await
        .unwrap();
    let observed = Arc::new(StdMutex::new(None));
    let worker_observed = observed.clone();
    let worker_store = store.clone();
    let worker_space = space.clone();
    tokio::task::spawn_blocking(move || {
        SpaceStore::set_retrieval_mode_chunked_with_control(
            &worker_store,
            &worker_space,
            RetrievalMode::Graph,
            &|| false,
            &|| {
                // Staged, before the swap: the connection is free here.
                let conn = worker_store.conn.blocking_lock();
                *worker_observed.lock().unwrap() = Some(staging_schemas(&conn));
                true
            },
            &mut |_processed, _nodes, _edges, _total| {},
        )
    })
    .await
    .unwrap()
    .unwrap();
    assert_eq!(
        *observed.lock().unwrap(),
        Some((2, 0)),
        "staging tables must be main-schema tables, not TEMP (temp_store is MEMORY)"
    );
    assert_eq!(
        store.space_mode(&space).await.unwrap(),
        RetrievalMode::Graph
    );
    let conn = store.conn.lock().await;
    assert_eq!(staging_schemas(&conn), (0, 0), "dropped after the swap");
}

#[tokio::test]
async fn graph_mode_staging_left_by_a_crash_is_dropped_at_open() {
    let dir = tempfile::tempdir().unwrap();
    {
        let store = open_file_store(dir.path(), keys());
        let conn = store.conn.lock().await;
        create_retrieval_staging(&conn).unwrap();
        assert_eq!(staging_schemas(&conn), (2, 0));
    }
    let store = open_file_store(dir.path(), keys());
    let conn = store.conn.lock().await;
    assert_eq!(staging_schemas(&conn), (0, 0));
}
