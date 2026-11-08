//! Local audit-log, usage analytics, control-change, and exec audit/budget
//! endpoints. Split by responsibility; every handler and body type is
//! re-exported here so `crate::api::audit::X` paths stay stable.

mod control;
mod exec;
mod query;
mod usage_cost;
mod widget_limiter;

// Body/param types are re-exported for path stability (`crate::api::audit::X`)
// even where only the handlers are referenced outside this module.
#[allow(unused_imports)]
pub use control::{record_control_change, ControlAuditBody};
#[allow(unused_imports)]
pub use exec::{
    check_exec_budget, ingest_exec_audit, ExecAuditBody, ExecBudgetCheckBody,
    ExecBudgetCheckResponse,
};
#[allow(unused_imports)]
pub use query::{
    prune_audit, query_audit, query_audit_usage, AuditQueryParams, AuditUsageQueryParams,
};
#[allow(unused_imports)]
pub use widget_limiter::{widget_call_allowed, widget_followup_allowed};

#[cfg(test)]
mod test_support;

#[cfg(test)]
mod exec_tests;

#[cfg(test)]
mod query_tests;

#[cfg(test)]
mod usage_tests;

#[cfg(test)]
mod prune_tests;

#[cfg(test)]
mod control_tests;
