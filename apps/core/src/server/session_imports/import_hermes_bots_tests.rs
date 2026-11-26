//! Every Hermes bot (`profiles/<name>/`) imports as its own agent, and a
//! second import of the same home adds nothing.

use crate::import::{kind, scan_source, ImportSelection};
use crate::server::memory::MemoryFilter;
use crate::server::{apply_import_selections, isolated_plugin_hook_test_state};

fn write(root: &std::path::Path, rel: &str, body: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

#[tokio::test]
async fn hermes_bots_import_once_and_a_second_run_adds_nothing() {
    let source = tempfile::tempdir().unwrap();
    let root = source.path().join(".hermes");
    std::fs::create_dir_all(&root).unwrap();
    let root = root.canonicalize().unwrap();
    write(
        &root,
        "config.yaml",
        "model:\n  default: claude-sonnet-4-6\n  provider: anthropic\n",
    );
    write(&root, "SOUL.md", "You are the default Hermes persona.\n");
    write(&root, "memories/MEMORY.md", "Default fact\n");
    write(&root, "profiles/coder/SOUL.md", "You write code.\n");
    write(
        &root,
        "profiles/coder/profile.yaml",
        "display_name: Hermes Coder Bot\n",
    );
    write(
        &root,
        "profiles/coder/memories/MEMORY.md",
        "The repo uses bun\n§\nTests run before every commit\n",
    );
    write(&root, "profiles/research/SOUL.md", "You research topics.\n");
    write(
        &root,
        "profiles/research/profile.yaml",
        "ui_meta:\n  hermes-bots:\n    title: Hermes Research Lead\n",
    );

    let state_dir = tempfile::tempdir().unwrap();
    let mut state = isolated_plugin_hook_test_state(state_dir.path());
    state.agent_store = crate::agents::AgentStore::open_in_memory(&state.agents).unwrap();
    let agents_before = state.agent_store.list().await.unwrap().len();

    let selections = || -> Vec<ImportSelection> {
        scan_source(&root)
            .unwrap()
            .items
            .into_iter()
            .filter(|item| item.kind == kind::AGENT || item.kind == kind::MEMORY)
            .map(|item| ImportSelection {
                kind: item.kind.to_string(),
                id: item.id,
            })
            .collect()
    };
    let first_selection = selections();
    assert_eq!(
        first_selection
            .iter()
            .filter(|selection| selection.kind == kind::AGENT)
            .count(),
        3
    );

    let first = apply_import_selections(&state, &None, &root, first_selection).await;
    assert!(
        first.iter().all(|outcome| outcome.status == "imported"),
        "{first:?}"
    );
    let agents = state.agent_store.list().await.unwrap();
    assert_eq!(agents.len(), agents_before + 3);
    for name in ["hermes", "Hermes Coder Bot", "Hermes Research Lead"] {
        assert!(agents.iter().any(|agent| agent.name == name), "{name}");
    }
    let memories = state.memory.list(&MemoryFilter::default()).await.unwrap();
    assert_eq!(memories.len(), 3, "{memories:?}");

    let second = apply_import_selections(&state, &None, &root, selections()).await;
    assert!(
        second.iter().all(|outcome| outcome.status != "failed"),
        "{second:?}"
    );
    assert!(
        second
            .iter()
            .filter(|outcome| outcome.kind == kind::AGENT)
            .all(|outcome| outcome.status == "skipped" && outcome.already_exists),
        "{second:?}"
    );
    assert_eq!(
        state.agent_store.list().await.unwrap().len(),
        agents_before + 3
    );
    assert_eq!(
        state
            .memory
            .list(&MemoryFilter::default())
            .await
            .unwrap()
            .len(),
        3
    );
}
