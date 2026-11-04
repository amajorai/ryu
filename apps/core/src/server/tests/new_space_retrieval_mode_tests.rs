use crate::registry::ProviderRegistry;
use crate::server::decide_new_space_mode;
use crate::server::spaces::RetrievalMode;

/// The composition this handler performs, run against a registry built with no
/// env read at all (`ProviderRegistry::default()`), so the assertions are
/// hermetic. The env/`registry.json` half of the precedence is pinned in
/// `registry::tests` where the env lock lives.
#[test]
fn body_mode_wins_and_absent_falls_back_to_the_node_default() {
    let reg = ProviderRegistry::default();

    // Absent ⇒ node default ⇒ "vector". This is the backward-compatibility
    // guarantee: every client that never heard of `retrieval_mode` keeps
    // getting exactly the Space it got before.
    assert_eq!(
        decide_new_space_mode(reg.resolve_rag_strategy(None), false),
        Ok(RetrievalMode::Vector)
    );
    // Empty string is "absent", not a mode named nothing.
    assert_eq!(
        decide_new_space_mode(reg.resolve_rag_strategy(Some("")), false),
        Ok(RetrievalMode::Vector)
    );
    // Explicit values reach the store verbatim — this is what makes graph mode
    // reachable at all from HTTP.
    assert_eq!(
        decide_new_space_mode(reg.resolve_rag_strategy(Some("graph")), true),
        Ok(RetrievalMode::Graph)
    );
    assert_eq!(
        decide_new_space_mode(reg.resolve_rag_strategy(Some("vector")), true),
        Ok(RetrievalMode::Vector)
    );
}

/// A caller typo is a 400 that names the value and the accepted spellings —
/// never a silently-vector Space. Case matters: the column and the wire form are
/// lowercase, so `"Graph"` is a typo, not a synonym.
#[test]
fn a_caller_typo_is_rejected_rather_than_degraded() {
    for bad in ["graphrag", "Graph", "GRAPH", "knn", "vector "] {
        let err = decide_new_space_mode(bad, true)
            .expect_err("an unknown caller-supplied mode must be rejected");
        assert!(err.contains(bad), "error must name the bad value: {err}");
        assert!(err.contains("vector") && err.contains("graph"));
    }
}

/// An operator typo in `RYU_RAG_STRATEGY` / `registry.json` cannot fail a
/// request the caller made correctly, so it degrades to vector — but loudly
/// (`tracing::warn!`), never silently. Pinned so nobody "simplifies" the two
/// branches into one lenient parse.
#[test]
fn an_operator_typo_degrades_to_vector_instead_of_failing_the_request() {
    assert_eq!(
        decide_new_space_mode("graphrag", false),
        Ok(RetrievalMode::Vector)
    );
}

/// The end-to-end wiring: a `registry.json` on disk reaches the mode a new Space
/// is stamped with, through [`resolve_new_space_mode`] — the function
/// `create_space` actually calls.
///
/// Every other test in this module drives `decide_new_space_mode`, the pure half,
/// and every test in `registry::tests` drives `ProviderRegistry` directly. Their
/// *composition* — "the handler builds its registry with a constructor that reads
/// the file" — was covered by nothing, which is exactly where the bug lived:
/// `from_env()` opens no file, so the file half of the knob was dead while three
/// docstrings and the desktop client advertised it. This test is the one that
/// fails if someone swaps the constructor back.
///
/// `RYU_REGISTRY_PATH` must be *set*, not merely cleared: unset means
/// `~/.ryu/registry.json`, i.e. the developer's real config. And the lock comes
/// from `registry` rather than being a local one, because these are the same
/// process-global vars `registry::tests` mutates.
#[test]
fn registry_file_rag_strategy_reaches_space_creation() {
    use crate::server::resolve_new_space_mode;

    let _lock = crate::registry::lock_registry_env();
    let _g = crate::registry::RegistryEnvGuard::capture();
    let dir = tempfile::tempdir().expect("tempdir");
    let path = dir.path().join("registry.json");
    std::fs::write(&path, r#"{"rag_strategy":"graph"}"#).expect("write registry.json");
    std::env::set_var("RYU_REGISTRY_PATH", &path);

    // No `retrieval_mode` in the request body ⇒ the node-wide file default wins.
    assert_eq!(resolve_new_space_mode(None), Ok(RetrievalMode::Graph));
    // …and an empty one is still "absent".
    assert_eq!(resolve_new_space_mode(Some("")), Ok(RetrievalMode::Graph));
    // A caller who names a mode still overrides the node default, in the
    // direction that would otherwise be invisible: file says graph, body says
    // vector, body wins.
    assert_eq!(
        resolve_new_space_mode(Some("vector")),
        Ok(RetrievalMode::Vector)
    );

    // Env still outranks the file on the production path too.
    std::env::set_var("RYU_RAG_STRATEGY", "vector");
    assert_eq!(resolve_new_space_mode(None), Ok(RetrievalMode::Vector));
}
