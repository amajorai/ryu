use crate::server::valid_retrieval_chunk_id;

#[test]
fn stable_ids_are_bounded_and_control_free() {
    assert!(valid_retrieval_chunk_id("command-palette-memory"));
    assert!(valid_retrieval_chunk_id("  trimmed-id  "));
    assert!(!valid_retrieval_chunk_id(""));
    assert!(!valid_retrieval_chunk_id("\n"));
    assert!(!valid_retrieval_chunk_id(&"x".repeat(201)));
}
