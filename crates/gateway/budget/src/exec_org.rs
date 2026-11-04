//! Org-scoped exec-budget windows.
//!
//! A hosted Gateway serves many orgs' Cores. When every org shared the one
//! process-wide window, one org's exec rows (or a large `duration_ms`) could
//! exhaust it and refuse every other org's sandbox runs. A caller bound to an
//! org (a per-org Core relay key) is counted and checked in that org's own
//! window, with the same configured limits; an unscoped caller (the master key
//! or the operator's own Core) keeps the global window.

use std::collections::HashMap;
use std::time::Instant;

use super::{ExecBudgetAction, ExecBudgetEnforcer, ExecBudgetResult, ExecWindowState};

/// Most org windows kept at once. Expired windows are pruned first; past the
/// cap the oldest window is dropped (that org restarts at zero).
const MAX_ORG_WINDOWS: usize = 4096;

impl ExecBudgetEnforcer {
    /// The verdict for one window's counters (already reset if expired).
    pub(crate) fn verdict(&self, state: &ExecWindowState) -> ExecBudgetResult {
        let count_ok = self.config.max_count == 0 || state.exec_count < self.config.max_count;
        let wc_secs = state.wall_clock_ms / 1000;
        let wc_ok =
            self.config.max_wall_clock_secs == 0 || wc_secs < self.config.max_wall_clock_secs;
        if count_ok && wc_ok {
            return ExecBudgetResult::Allow;
        }
        match self.config.action {
            ExecBudgetAction::Notify => ExecBudgetResult::Allow,
            ExecBudgetAction::Stop => ExecBudgetResult::Deny {
                exec_count: state.exec_count,
                wall_clock_secs: wc_secs,
                limit_count: self.config.max_count,
                limit_wall_clock_secs: self.config.max_wall_clock_secs,
            },
        }
    }

    /// [`Self::check`] in `org`'s own window, or the global one for `None`.
    pub fn check_scoped(&self, org: Option<&str>) -> ExecBudgetResult {
        let Some(org) = org else {
            return self.check();
        };
        self.with_org_window(org, |enforcer, window| enforcer.verdict(window))
    }

    /// [`Self::record`] in `org`'s own window, or the global one for `None`.
    pub fn record_scoped(&self, org: Option<&str>, duration_ms: u64) {
        let Some(org) = org else {
            self.record(duration_ms);
            return;
        };
        self.with_org_window(org, |_, window| {
            window.exec_count = window.exec_count.saturating_add(1);
            window.wall_clock_ms = window.wall_clock_ms.saturating_add(duration_ms);
        });
    }

    /// [`Self::current_count`] for `org`'s window, or the global one for `None`.
    pub fn current_count_scoped(&self, org: Option<&str>) -> u64 {
        let Some(org) = org else {
            return self.current_count();
        };
        self.with_org_window(org, |_, window| window.exec_count)
    }

    fn with_org_window<T>(
        &self,
        org: &str,
        apply: impl FnOnce(&Self, &mut ExecWindowState) -> T,
    ) -> T {
        let mut orgs = self.orgs.lock().unwrap_or_else(|p| p.into_inner());
        if !orgs.contains_key(org) && orgs.len() >= MAX_ORG_WINDOWS {
            self.make_room(&mut orgs);
        }
        let window = orgs
            .entry(org.to_owned())
            .or_insert_with(|| ExecWindowState {
                window_start: Instant::now(),
                exec_count: 0,
                wall_clock_ms: 0,
            });
        self.maybe_reset_window(window);
        apply(self, window)
    }

    fn make_room(&self, orgs: &mut HashMap<String, ExecWindowState>) {
        let window = std::time::Duration::from_secs(self.config.window_secs);
        orgs.retain(|_, state| state.window_start.elapsed() < window);
        if orgs.len() < MAX_ORG_WINDOWS {
            return;
        }
        let oldest = orgs
            .iter()
            .min_by_key(|(_, state)| state.window_start)
            .map(|(org, _)| org.clone());
        if let Some(oldest) = oldest {
            orgs.remove(&oldest);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ExecBudgetConfig;

    fn stop_after(max_count: u64) -> ExecBudgetEnforcer {
        ExecBudgetEnforcer::new(ExecBudgetConfig {
            max_count,
            max_wall_clock_secs: 0,
            window_secs: 3600,
            action: ExecBudgetAction::Stop,
        })
    }

    #[test]
    fn one_orgs_exec_rows_do_not_exhaust_another_orgs_window() {
        let enforcer = stop_after(1);
        enforcer.record_scoped(Some("org-a"), 10);
        assert!(matches!(
            enforcer.check_scoped(Some("org-a")),
            ExecBudgetResult::Deny { exec_count: 1, .. }
        ));
        assert_eq!(
            enforcer.check_scoped(Some("org-b")),
            ExecBudgetResult::Allow
        );
        // Nor the operator's own (unscoped) window.
        assert_eq!(enforcer.check_scoped(None), ExecBudgetResult::Allow);
        assert_eq!(enforcer.current_count_scoped(Some("org-a")), 1);
        assert_eq!(enforcer.current_count_scoped(Some("org-b")), 0);
        assert_eq!(enforcer.current_count(), 0);
    }

    #[test]
    fn an_unscoped_caller_keeps_the_global_window() {
        let enforcer = stop_after(1);
        enforcer.record_scoped(None, 10);
        assert!(matches!(enforcer.check(), ExecBudgetResult::Deny { .. }));
        assert!(matches!(
            enforcer.check_scoped(None),
            ExecBudgetResult::Deny { .. }
        ));
        assert_eq!(
            enforcer.check_scoped(Some("org-a")),
            ExecBudgetResult::Allow
        );
    }

    #[test]
    fn a_huge_duration_saturates_instead_of_overflowing() {
        let enforcer = ExecBudgetEnforcer::new(ExecBudgetConfig {
            max_count: 0,
            max_wall_clock_secs: 60,
            window_secs: 3600,
            action: ExecBudgetAction::Stop,
        });
        enforcer.record_scoped(Some("org-a"), u64::MAX);
        enforcer.record_scoped(Some("org-a"), u64::MAX);
        assert!(matches!(
            enforcer.check_scoped(Some("org-a")),
            ExecBudgetResult::Deny { .. }
        ));
        assert_eq!(
            enforcer.check_scoped(Some("org-b")),
            ExecBudgetResult::Allow
        );
    }

    #[test]
    fn the_org_window_map_stays_bounded() {
        let enforcer = stop_after(1);
        for index in 0..=MAX_ORG_WINDOWS {
            enforcer.record_scoped(Some(&format!("org-{index}")), 1);
        }
        let held = enforcer.orgs.lock().unwrap().len();
        assert!(held <= MAX_ORG_WINDOWS);
        assert!(matches!(
            enforcer.check_scoped(Some(&format!("org-{MAX_ORG_WINDOWS}"))),
            ExecBudgetResult::Deny { .. }
        ));
    }
}
