use crate::utils::wall_micros;

/// An entry pushed onto the undo stack before each executed step.
#[derive(Debug, Clone)]
pub struct UndoEntry {
    pub step_index: usize,
    /// Tool name that was about to execute (e.g. "ax_click").
    pub action_type: String,
    /// FNV hash of the AX tree state captured immediately before the step.
    pub ax_tree_hash: u64,
    pub timestamp_us: u64,
    /// App that was in focus, if known (for SwitchBack strategy).
    pub app_context: Option<String>,
    /// Scroll deltas for ReverseScroll strategy.
    pub scroll_dx: Option<i32>,
    pub scroll_dy: Option<i32>,
}

/// Strategy computed when undoing an entry.
#[derive(Debug, Clone)]
pub enum UndoStrategy {
    /// Send Ctrl+Z / Cmd+Z.
    UndoShortcut,
    /// Switch focus back to a previous app.
    SwitchBack(String),
    /// Scroll the opposite amount.
    ReverseScroll { dx: i32, dy: i32 },
    /// Cannot auto-undo; human intervention required.
    Manual(String),
}

/// LIFO stack of pre-step snapshots enabling step reversal.
pub struct ExecutionUndoManager {
    stack: Vec<UndoEntry>,
    max_size: usize,
}

impl ExecutionUndoManager {
    pub fn new() -> Self {
        Self {
            stack: Vec::new(),
            max_size: 50,
        }
    }

    /// Push an entry. Trims oldest entries when `max_size` is exceeded.
    pub fn push(&mut self, entry: UndoEntry) {
        if self.stack.len() >= self.max_size {
            self.stack.remove(0);
        }
        self.stack.push(entry);
    }

    /// Build and push a new entry in one call.
    pub fn push_step(
        &mut self,
        step_index: usize,
        action_type: impl Into<String>,
        ax_tree_hash: u64,
        app_context: Option<String>,
        scroll_dx: Option<i32>,
        scroll_dy: Option<i32>,
    ) {
        self.push(UndoEntry {
            step_index,
            action_type: action_type.into(),
            ax_tree_hash,
            timestamp_us: wall_micros(),
            app_context,
            scroll_dx,
            scroll_dy,
        });
    }

    /// Remove and return the most recent entry.
    pub fn pop(&mut self) -> Option<UndoEntry> {
        self.stack.pop()
    }

    /// Inspect the most recent entry without removing it.
    pub fn peek(&self) -> Option<&UndoEntry> {
        self.stack.last()
    }

    /// Clear all entries.
    pub fn clear(&mut self) {
        self.stack.clear();
    }

    /// Length of the stack.
    pub fn len(&self) -> usize {
        self.stack.len()
    }

    pub fn is_empty(&self) -> bool {
        self.stack.is_empty()
    }

    /// Compute the reversal strategy for an entry without popping it.
    pub fn compute_reversal(entry: &UndoEntry) -> UndoStrategy {
        match entry.action_type.as_str() {
            "ax_click" | "ax_type" | "ax_hotkey" => UndoStrategy::UndoShortcut,
            "ax_scroll" => UndoStrategy::ReverseScroll {
                dx: -entry.scroll_dx.unwrap_or(0),
                dy: -entry.scroll_dy.unwrap_or(0),
            },
            "ax_focus_app" => {
                if let Some(app) = &entry.app_context {
                    UndoStrategy::SwitchBack(app.clone())
                } else {
                    UndoStrategy::Manual("Cannot restore focus: previous app unknown".to_string())
                }
            }
            other => UndoStrategy::Manual(format!("No auto-undo for action '{}'", other)),
        }
    }

    /// Pop the most recent entry and return its reversal strategy.
    pub fn pop_reversal(&mut self) -> Option<UndoStrategy> {
        self.stack.pop().map(|e| Self::compute_reversal(&e))
    }
}

impl Default for ExecutionUndoManager {
    fn default() -> Self {
        Self::new()
    }
}
