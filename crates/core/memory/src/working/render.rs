//! The per-turn `<working_memory>` context block.

use serde_json::{Map, Value};

use super::{
    WorkingMemory, WorkingMemoryConfig, WorkingMemoryMode, WorkingMemoryScope,
    DEFAULT_WORKING_MEMORY_TEMPLATE,
};

/// Render the per-turn context block for a working-memory document, or for an
/// empty one seeded from `config` when nothing has been stored yet. The block
/// tells the model what the scratchpad is, how to update it, and which version
/// it is looking at, so its update can carry `expected_version`.
pub fn render_working_memory_block(
    doc: Option<&WorkingMemory>,
    config: &WorkingMemoryConfig,
    tool_name: &str,
) -> String {
    // The agent's configuration decides the mode: the update tool always writes
    // in `config.mode()`, so a stored document in the other mode (e.g. one
    // written through the HTTP API) is shown as empty rather than with
    // instructions the tool cannot follow.
    let mode = config.mode();
    // The version guards the stored row whatever its mode, so it is read before
    // a mismatched document is hidden.
    let version = doc.map_or(0, |doc| doc.version);
    let doc = doc.filter(|doc| doc.mode == mode);
    let mut block = String::from("<working_memory>\n");
    block.push_str("This is your working memory: a persistent scratchpad for this ");
    block.push_str(match config.scope {
        WorkingMemoryScope::Thread => "conversation",
        WorkingMemoryScope::Resource => "user across conversations",
    });
    block.push_str(". Keep it current. ");
    match mode {
        WorkingMemoryMode::Template => {
            block.push_str(&format!(
                "When you learn something worth keeping, call `{tool_name}` with the COMPLETE \
                 updated Markdown in `content` (it replaces the whole document). Do not mention \
                 the scratchpad to the user. "
            ));
            block.push_str(&version_instructions(version));
            let content = doc
                .and_then(|doc| doc.content.clone())
                .filter(|content| !content.trim().is_empty());
            match content {
                Some(content) => block.push_str(content.trim_end()),
                None => {
                    let template = doc
                        .and_then(|doc| doc.template.clone())
                        .or_else(|| config.template.clone())
                        .unwrap_or_else(|| DEFAULT_WORKING_MEMORY_TEMPLATE.to_owned());
                    block.push_str("(empty — fill in this template)\n");
                    block.push_str(template.trim_end());
                }
            }
        }
        WorkingMemoryMode::Schema => {
            block.push_str(&format!(
                "When you learn something worth keeping, call `{tool_name}` with `data` set to \
                 a JSON merge patch: only the fields that changed; `null` removes a field. Do \
                 not mention the scratchpad to the user. "
            ));
            block.push_str(&version_instructions(version));
            let data = doc
                .and_then(|doc| doc.data.clone())
                .unwrap_or_else(|| Value::Object(Map::new()));
            block.push_str("Current value:\n");
            block.push_str(&serde_json::to_string_pretty(&data).unwrap_or_else(|_| "{}".into()));
            let schema = doc
                .and_then(|doc| doc.schema.clone())
                .or_else(|| config.schema.clone());
            if let Some(schema) = schema {
                block.push_str("\n\nSchema:\n");
                block.push_str(&serde_json::to_string(&schema).unwrap_or_default());
            }
        }
    }
    block.push_str("\n</working_memory>");
    block
}

/// The concurrency part of the instructions: which version the block shows and
/// what to do when an update is refused because another writer got there first.
fn version_instructions(version: i64) -> String {
    format!(
        "This is version {version}: pass `expected_version: {version}` with your update (for a \
         later update in the same turn, use the `version` your last update returned). If the \
         update is refused because the version changed, merge your change into the current \
         document the error shows and retry with its version.\n\n"
    )
}
