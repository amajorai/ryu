//! Budget stage — extracted to the `ryu-gw-budget` crate (decomposition W6).
//!
//! This module is now a thin re-export shim: the built-in [`BudgetEnforcer`],
//! the swappable [`BudgetBackend`] trait + [`BudgetRegistry`], the per-window
//! [`ExecBudgetEnforcer`], and the [`SharedBudgetState`] / [`WalletState`]
//! caches all live in the `ryu-gw-budget` crate. Keeping `crate::budget::…`
//! paths (and the intra-doc links in firewall/router/smart/passthrough that
//! point at [`BudgetRegistry`]) working means the extraction is invisible to
//! every consumer — zero call-site churn.
//!
//! The budget config value-types ([`BudgetConfig`], [`BudgetRule`], …) also live
//! in the crate and are re-exported from [`crate::config`], so `GatewayConfig`
//! still embeds `budgets` / `exec_budget` unchanged.

pub use ryu_gw_budget::*;
