pub mod consolidator;
pub mod directive;
pub mod query_planner;
pub mod semantic;

pub use consolidator::SemanticConsolidator;
pub use directive::{Directive, DirectiveMemoryStore};
pub use query_planner::{MemoryQueryPlanner, MemoryResult, MemorySource, QueryPlan};
pub use semantic::{MemoryEntry, SemanticMemoryStore};

use anyhow::Result;
use std::sync::{Mutex, OnceLock};

/// Unified memory facade combining semantic and directive stores.
pub struct MemoryStore {
    pub semantic: SemanticMemoryStore,
    directive: DirectiveMemoryStore,
}

/// Global memory store — initialized once via init_memory().
/// Wrapped in Mutex because rusqlite::Connection is !Sync.
pub static MEMORY_STORE: OnceLock<Mutex<MemoryStore>> = OnceLock::new();

/// Initialize the global memory store.
pub fn init_memory(db_path: &std::path::Path) -> Result<()> {
    std::fs::create_dir_all(db_path.parent().unwrap_or(std::path::Path::new(".")))?;
    let semantic = SemanticMemoryStore::new(db_path)?;
    let directive = DirectiveMemoryStore::new(db_path)?;
    MEMORY_STORE
        .set(Mutex::new(MemoryStore {
            semantic,
            directive,
        }))
        .map_err(|_| anyhow::anyhow!("Memory store already initialized"))?;
    Ok(())
}

impl MemoryStore {
    /// Query semantic memory by optional category and text.
    pub fn query(&self, category: Option<&str>, text: &str) -> Result<Vec<MemoryEntry>> {
        self.semantic.query(category, text)
    }

    /// Store or update a semantic memory entry.
    pub fn upsert(&self, entry: &MemoryEntry) -> Result<()> {
        self.semantic.upsert(entry)
    }

    /// Delete a semantic memory entry by ID.
    pub fn delete_entry(&self, id: &str) -> Result<()> {
        self.semantic.delete(id)
    }

    /// Create a new directive.
    pub fn create_directive(&self, directive: &Directive) -> Result<()> {
        self.directive.create(directive)
    }

    /// List active directives, optionally filtered by type.
    pub fn list_active(&self, type_filter: Option<&str>) -> Result<Vec<Directive>> {
        self.directive.list_active(type_filter)
    }

    /// Mark a directive as completed.
    pub fn complete_directive(&self, id: &str) -> Result<()> {
        self.directive.complete(id)
    }

    /// Check which directives match the current context.
    pub fn check_triggers(&self, context: &str) -> Result<Vec<Directive>> {
        self.directive.check_triggers(context)
    }
}
