//! TC-8: the 30 second folder sync worker never imports an MCP server.
//!
//! Before the fix the worker relied on an accident: an `mcp_server` item id is
//! not a path, so the item could not be hashed and was dropped. An item whose
//! id ended with `#saved-context` took the chat export short cut instead, was
//! "hashed" by the export fingerprint (which succeeds on any readable folder)
//! and was imported with nobody present. The server name is a raw key of the
//! scanned file, so whoever could write `mcp.json` into a synced folder chose
//! it. `reconcile_import` is the body of one tick of `spawn_worker` for one
//! profile.
use super::*;

/// Points `McpRegistry::config_path()` at a temp `mcp.json` for one test and
/// restores the previous value, also when the test panics.
struct McpConfigPath(Option<std::ffi::OsString>);

impl McpConfigPath {
    fn set(path: &Path) -> Self {
        let previous = std::env::var_os("RYU_MCP_CONFIG");
        std::env::set_var("RYU_MCP_CONFIG", path);
        Self(previous)
    }
}

impl Drop for McpConfigPath {
    fn drop(&mut self) {
        match self.0.take() {
            Some(previous) => std::env::set_var("RYU_MCP_CONFIG", previous),
            None => std::env::remove_var("RYU_MCP_CONFIG"),
        }
    }
}

fn selection(kind: &str, id: &str) -> ImportSelection {
    ImportSelection {
        kind: kind.to_owned(),
        id: id.to_owned(),
    }
}

const SUFFIXED_SERVER: &str = "x#saved-context";
const SUFFIXED_ITEM: &str = "mcp_server/mcp/json/x#saved-context";
const PLAIN_ITEM: &str = "mcp_server/mcp/json/plain";
const INSTRUCTIONS_ITEM: &str = "instructions/AGENTS.md";

#[tokio::test]
async fn the_sync_worker_never_imports_an_mcp_server() {
    let _env = crate::sidecar::gateway::lock_gateway_env();
    let directory = tempfile::tempdir().unwrap();
    let root = directory.path().join("synced");
    fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    fs::write(root.join("AGENTS.md"), "Be brief.\n").unwrap();
    fs::write(
        root.join("mcp.json"),
        r#"{"mcpServers":{"x#saved-context":{"command":"ryu-tc8-no-such-binary"},"plain":{"command":"ryu-tc8-no-such-binary"}}}"#,
    )
    .unwrap();
    let config = directory.path().join("ryu-mcp.json");
    let _path = McpConfigPath::set(&config);
    let state = crate::server::isolated_plugin_hook_test_state(directory.path());
    let store = AgentSyncStore::open_in_memory().unwrap();
    let profile = store
        .upsert_profile(ProfileInput {
            id: Some(format!("tc8-{}", uuid::Uuid::new_v4())),
            provider: "claude".to_owned(),
            root: root.to_string_lossy().to_string(),
            import_enabled: true,
            export_enabled: false,
            include_conversations: None,
        })
        .await
        .unwrap();

    // The scan does list both servers: the worker has to leave them alone.
    let scanned: Vec<String> = crate::import::scan_source(&root)
        .unwrap()
        .items
        .into_iter()
        .map(|item| item.id)
        .collect();
    for id in [SUFFIXED_ITEM, PLAIN_ITEM, INSTRUCTIONS_ITEM] {
        assert!(
            scanned.iter().any(|item| item == id),
            "{id} not in {scanned:?}"
        );
    }

    reconcile_import(&state, &store, &profile).await;

    // The tick ran and handled the folder: the instructions item has a row.
    assert!(
        store
            .item(
                &profile.id,
                crate::import::kind::INSTRUCTIONS,
                INSTRUCTIONS_ITEM
            )
            .await
            .unwrap()
            .is_some(),
        "the worker did not process the folder"
    );
    let installed = crate::sidecar::mcp::installed_configs();
    assert!(
        !installed.contains_key(SUFFIXED_SERVER),
        "the worker wrote an MCP server with no user step: {installed:?}"
    );
    assert!(!installed.contains_key("plain"), "{installed:?}");
    for id in [SUFFIXED_ITEM, PLAIN_ITEM] {
        assert!(
            store
                .item(&profile.id, crate::import::kind::MCP_SERVER, id)
                .await
                .unwrap()
                .is_none(),
            "{id} must not reach the sync ledger"
        );
    }
}

#[test]
fn only_a_memory_item_takes_the_saved_context_short_cut() {
    use crate::import::kind;
    for other in [kind::MCP_SERVER, kind::PLUGIN, kind::SKILL, kind::AGENT] {
        assert!(
            !is_chat_export_selection(&selection(other, &format!("{other}/x#saved-context"))),
            "{other}"
        );
    }
    assert!(!is_chat_export_selection(&selection(
        kind::MCP_SERVER,
        SUFFIXED_ITEM
    )));
    assert!(is_chat_export_selection(&selection(
        kind::MEMORY,
        "memory/conversations.json#saved-context"
    )));
    assert!(is_chat_export_selection(&selection(
        kind::CONVERSATIONS,
        "conversations/conversations.json#chats"
    )));
}

#[test]
fn an_mcp_item_is_not_hashed_by_the_export_fingerprint() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(
        directory.path().join("mcp.json"),
        r#"{"mcpServers":{"x#saved-context":{"command":"ryu-tc8-no-such-binary"}}}"#,
    )
    .unwrap();
    let mut budget = HashBudget::default();
    let hashed = hash_selected_item_with_budget(
        directory.path(),
        &selection(crate::import::kind::MCP_SERVER, SUFFIXED_ITEM),
        &mut budget,
    );
    // The manual sync route reports an item it cannot hash as skipped and
    // never passes it on, which is what it does for every other MCP item.
    assert!(hashed.is_err(), "{hashed:?}");
}
