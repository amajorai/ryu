//! Linux backend: AT-SPI2 (primary) with x11rb window geometry (fallback).
//!
//! AT-SPI2 is the Linux equivalent of macOS AXUIElement / Windows IUIAutomation: a
//! D-Bus accessibility bus that toolkits (GTK, Qt, Electron, Firefox, Chromium) expose
//! their element trees on. It is display-server-agnostic, so it works under both X11
//! and Wayland. The catch is that the a11y bus is frequently disabled on a desktop:
//! when it cannot be reached, a snapshot of the focused window degrades to the
//! x11rb path, which returns the window's geometry and its child windows. Live
//! resolution and semantic actions need AT-SPI and fail with PERM_DENIED instead.
//!
//! Each public call opens one `AccessibilityConnection` and reuses it. Every AT-SPI
//! property read is a D-Bus round trip, so the walk limits and the time budget
//! matter even more here than on the other platforms.

use std::time::Instant;

use super::find::{find_in_tree, FindOptions};
use super::*;

mod actions;
mod actions_state;
mod at_spi;
mod conn;
mod nav;
mod pid;
mod snapshot;
mod x11;

const FIND_OPTIONS: FindOptions = FindOptions {
    match_identifier: true,
    match_value: true,
};

pub struct LinuxAXTree;

impl LinuxAXTree {
    pub fn new() -> Result<Self> {
        Ok(Self)
    }
}

#[async_trait]
impl AXTree for LinuxAXTree {
    async fn get_focused_tree(&self) -> Result<AXTreeNode> {
        // The private snapshot walk (with its X11 fallback), never `self.snapshot`.
        snapshot::take(&SnapshotOptions::default())
            .await
            .map(|snap| snap.root)
            .map_err(anyhow::Error::from)
    }
    async fn find_element(&self, description: &str) -> Option<AXTreeNode> {
        // An empty query would match the root node (every string contains "").
        if description.trim().is_empty() {
            return None;
        }
        let tree = self.get_focused_tree().await.ok()?;
        find_in_tree(&tree, description, FIND_OPTIONS)
    }
    async fn element_at(&self, x: i32, y: i32) -> Option<AXTreeNode> {
        at_spi::element_at(x, y).await.ok().flatten()
    }
    async fn list_apps(&self) -> Vec<serde_json::Value> {
        at_spi::list_apps().await.unwrap_or_default()
    }

    async fn snapshot(&self, opts: SnapshotOptions) -> Result<AXSnapshot, GhostError> {
        snapshot::take(&opts).await
    }

    async fn resolve(
        &self,
        locator: &ElementLocator,
        deadline: Duration,
    ) -> Result<ResolvedElement, GhostError> {
        let deadline = Instant::now() + deadline;
        let a11y = conn::connect().await?;
        nav::resolve_live(a11y.connection(), locator, deadline)
            .await
            .map(|live| live.resolved)
    }

    async fn perform(
        &self,
        locator: &ElementLocator,
        action: &ElementAction,
        opts: &ActionOptions,
    ) -> Result<ActionOutcome, GhostError> {
        let deadline = Instant::now() + opts.deadline;
        let a11y = conn::connect().await?;
        actions::perform(a11y.connection(), locator, action, opts, deadline).await
    }
}

#[cfg(test)]
mod tests;
