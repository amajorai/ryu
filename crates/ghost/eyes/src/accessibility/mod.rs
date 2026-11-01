// Accessibility tree primitives — copied from apps/shadow/src/capture/accessibility.rs
// with shadow_core dependency removed.
//! Cross-platform accessibility tree: shared types, pure resolution/verification
//! helpers, and the per-OS backends (`uia` on Windows, `macos`, `linux`).

use std::time::Duration;

use anyhow::Result;
use async_trait::async_trait;

use crate::contract::{ErrorCode, GhostError};

mod action;
pub(crate) mod limits;
mod locator;
mod snapshot;
mod types;

#[cfg_attr(not(test), allow(dead_code))]
pub(crate) mod chain;
pub mod find;
pub mod resolve;
pub mod roles;
pub mod verify;

pub use action::{
    ActionOptions, ActionOutcome, ActionStep, ElementAction, MatchBy, ResolvedElement, StepOutcome,
    Verification, VerificationScope,
};
pub use limits::{TruncationCause, WalkLimits, WalkStats};
pub use locator::{ElementIdentity, ElementLocator};
#[allow(unused_imports)]
pub(crate) use snapshot::{pick_window_title, window_pick_error, TitlePick};
pub use snapshot::{AXSnapshot, RendererA11y, SnapshotOptions, WindowTarget};
pub use types::{AXTreeNode, Bounds, ElementState};

/// Accessibility tree trait. The semantic methods have defaults so existing
/// implementors keep compiling.
///
/// A backend that overrides `snapshot` must implement `get_focused_tree` on its
/// private walk function, never by calling `self.snapshot(..)`: the default
/// `snapshot` calls `get_focused_tree`, and the two would recurse forever.
#[async_trait]
pub trait AXTree: Send + Sync {
    async fn get_focused_tree(&self) -> Result<AXTreeNode>;
    async fn find_element(&self, description: &str) -> Option<AXTreeNode>;
    async fn element_at(&self, x: i32, y: i32) -> Option<AXTreeNode>;
    async fn list_apps(&self) -> Vec<serde_json::Value>;

    /// Default: `Focused` only (else PLATFORM_NOT_SUPPORTED); wraps
    /// `get_focused_tree` (errors via `GhostError::from_anyhow`); pid 0; complete false.
    async fn snapshot(&self, opts: SnapshotOptions) -> Result<AXSnapshot, GhostError> {
        if opts.target != WindowTarget::Focused {
            return Err(unsupported("window targets other than the focused window"));
        }
        let root = self
            .get_focused_tree()
            .await
            .map_err(|e| GhostError::from_anyhow(&e))?;
        let stats = WalkStats {
            nodes: count_nodes(&root),
            ..WalkStats::default()
        };
        Ok(AXSnapshot {
            pid: 0,
            app_name: None,
            window_title: root.title.clone(),
            complete: false,
            stats,
            renderer: RendererA11y::NotApplicable,
            root,
        })
    }

    /// Live resolve (path-first, identity check, pid check); default PLATFORM_NOT_SUPPORTED.
    async fn resolve(
        &self,
        _locator: &ElementLocator,
        _deadline: Duration,
    ) -> Result<ResolvedElement, GhostError> {
        Err(unsupported("live element resolution"))
    }

    /// Semantic action only, never HID; default PLATFORM_NOT_SUPPORTED.
    async fn perform(
        &self,
        _locator: &ElementLocator,
        _action: &ElementAction,
        _opts: &ActionOptions,
    ) -> Result<ActionOutcome, GhostError> {
        Err(unsupported("semantic element actions"))
    }
}

fn unsupported(what: &str) -> GhostError {
    GhostError::new(
        ErrorCode::PlatformNotSupported,
        format!("{what} are not supported by this accessibility backend"),
    )
}

fn count_nodes(node: &AXTreeNode) -> usize {
    1 + node.children.iter().map(count_nodes).sum::<usize>()
}

// ─── Windows: IUIAutomation ───────────────────────────────────────────────────

#[cfg(target_os = "windows")]
mod uia;
#[cfg(target_os = "windows")]
pub use uia::WindowsAXTree;

// ─── macOS ────────────────────────────────────────────────────────────────────

// Accessibility permission lives in the shared `ghost-permissions` crate (single
// source of truth across the desktop app, CLI, Core, and this sidecar).
// Re-exported so existing `ghost_eyes::accessibility_granted` call sites keep
// working.
pub use ghost_permissions::{accessibility_granted, request_accessibility};

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub use macos::MacOSAXTree;

// ─── Linux: AT-SPI2 (primary) with x11rb window geometry (fallback) ────────────

#[cfg(target_os = "linux")]
mod linux;
#[cfg(target_os = "linux")]
pub use linux::LinuxAXTree;

// ─── Platform aliases ─────────────────────────────────────────────────────────

#[cfg(target_os = "windows")]
pub type PlatformAXTree = WindowsAXTree;
#[cfg(target_os = "macos")]
pub type PlatformAXTree = MacOSAXTree;
#[cfg(target_os = "linux")]
pub type PlatformAXTree = LinuxAXTree;

#[cfg(test)]
mod tests;
