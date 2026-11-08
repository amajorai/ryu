//! Imported memories carry `Import` provenance, never the default `User`.

use crate::import::{kind, ImportSelection};
use crate::server::memory::{MemoryFilter, MemoryLifecycle, MemorySource};
use crate::server::{apply_import_selections, isolated_plugin_hook_test_state};

fn write(root: &std::path::Path, rel: &str, body: &str) {
    let path = root.join(rel);
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    std::fs::write(path, body).unwrap();
}

async fn import_and_list(
    root: &std::path::Path,
    rel: &str,
) -> Vec<crate::server::memory::LongTermEntry> {
    let state_dir = tempfile::tempdir().unwrap();
    let state = isolated_plugin_hook_test_state(state_dir.path());
    let selection = ImportSelection {
        kind: kind::MEMORY.into(),
        id: format!("{}/{rel}", kind::MEMORY),
    };
    let outcomes = apply_import_selections(&state, &None, root, vec![selection]).await;
    assert_eq!(outcomes.len(), 1);
    state.memory.list(&MemoryFilter::default()).await.unwrap()
}

#[tokio::test]
async fn a_claude_memory_file_is_recorded_as_an_import() {
    let dir = tempfile::tempdir().unwrap();
    let rel = "projects/abc-123/memory/11111111-1111-1111-1111-111111111111.md";
    write(
        dir.path(),
        rel,
        r#"{"content":"The build uses bun.","importance":3}"#,
    );
    let entries = import_and_list(dir.path(), rel).await;
    assert_eq!(entries.len(), 1, "{entries:?}");
    assert_eq!(entries[0].content, "The build uses bun.");
    assert_eq!(entries[0].provenance.source, MemorySource::Import);
    assert_eq!(entries[0].lifecycle, MemoryLifecycle::Active);
}

#[tokio::test]
async fn framework_markdown_memory_is_recorded_as_an_import() {
    let dir = tempfile::tempdir().unwrap();
    write(dir.path(), "openclaw.json", "{}");
    write(
        dir.path(),
        "MEMORY.md",
        "- Deploys go through the staging branch.\n- The team prefers squash merges.\n",
    );
    let entries = import_and_list(dir.path(), "MEMORY.md").await;
    assert_eq!(entries.len(), 2, "{entries:?}");
    for entry in &entries {
        assert_eq!(entry.provenance.source, MemorySource::Import);
    }
}
