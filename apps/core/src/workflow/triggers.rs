//! Trigger reconciliation for workflows.
//!
//! A workflow declares zero or more [`WorkflowTrigger`]s. On every save we
//! reconcile those declarations into the external resources that actually fire
//! the workflow, idempotently (a re-save converges to the declared set):
//!
//!   - [`WorkflowTrigger::Schedule`] → a [`ScheduledJob`] with a deterministic
//!     id `wf-sched-<workflow_id>-<idx>` and target [`JobTarget::Workflow`].
//!   - [`WorkflowTrigger::Composio`] → a Composio trigger subscription whose
//!     `target_kind` is `workflow`.
//!   - [`WorkflowTrigger::Manual`] / [`WorkflowTrigger::Webhook`] → no external
//!     resource (webhook ingress is a status surface, handled elsewhere).
//!
//! Per the Core-vs-Gateway rule this is **Core**: it wires up *when* a workflow
//! runs. Reconciliation is best-effort and never fails a save — callers log and
//! swallow any error so the workflow still persists.
//!
//! The pure diff lives in [`reconcile_schedule_jobs`] so it can be unit-tested
//! without disk or network; the impure wrapper [`apply_schedule_reconcile`]
//! lists/loads/saves the actual job files around it.

use super::WorkflowTrigger;
use crate::scheduler::store::{self as sched_store, JobTarget, Schedule, ScheduledJob};

/// Deterministic scheduler-job id for the `idx`-th schedule trigger of a
/// workflow. Stable across re-saves so reconciliation is idempotent.
pub fn schedule_job_id(workflow_id: &str, idx: usize) -> String {
    format!("wf-sched-{workflow_id}-{idx}")
}

/// The id prefix that marks a scheduler job as owned by `workflow_id`'s
/// schedule triggers. Used to find stale jobs to delete.
pub fn schedule_job_prefix(workflow_id: &str) -> String {
    format!("wf-sched-{workflow_id}-")
}

/// A schedule upsert the pure diff decided to apply: the deterministic job id,
/// a display name, and the resolved schedule.
#[derive(Debug, Clone, PartialEq)]
pub struct ScheduleUpsert {
    pub id: String,
    pub name: String,
    pub schedule: Schedule,
    /// Mirror of the trigger's `require_approval`: gate each firing on a
    /// human-in-the-loop approval instead of running autonomously.
    pub require_approval: bool,
}

/// The pure schedule-reconcile diff. Given a workflow's id, its triggers, and
/// the ids of the scheduler jobs that currently belong to it (i.e. start with
/// [`schedule_job_prefix`]), compute:
///   - `upserts`: the jobs that should exist for the current schedule triggers,
///   - `deletes`: existing owned-job ids no longer backed by a trigger.
///
/// A `Schedule` trigger with neither `cron` nor `every` is skipped (it cannot be
/// scheduled). `cron` wins when both are present. No disk or network here.
pub fn reconcile_schedule_jobs(
    workflow_id: &str,
    workflow_name: &str,
    triggers: &[WorkflowTrigger],
    existing_owned_ids: &[String],
) -> (Vec<ScheduleUpsert>, Vec<String>) {
    let mut upserts: Vec<ScheduleUpsert> = Vec::new();
    for (idx, trigger) in triggers.iter().enumerate() {
        if let WorkflowTrigger::Schedule {
            cron,
            every,
            require_approval,
        } = trigger
        {
            let schedule = match (cron, every) {
                (Some(expr), _) if !expr.trim().is_empty() => Schedule::Cron { expr: expr.clone() },
                (_, Some(interval)) if !interval.trim().is_empty() => Schedule::Every {
                    interval: interval.clone(),
                },
                // No usable schedule on this trigger — skip it.
                _ => continue,
            };
            upserts.push(ScheduleUpsert {
                id: schedule_job_id(workflow_id, idx),
                name: format!("{workflow_name} (schedule)"),
                schedule,
                require_approval: *require_approval,
            });
        }
    }

    let kept: std::collections::HashSet<&str> = upserts.iter().map(|u| u.id.as_str()).collect();
    let deletes: Vec<String> = existing_owned_ids
        .iter()
        .filter(|id| !kept.contains(id.as_str()))
        .cloned()
        .collect();

    (upserts, deletes)
}

/// Apply the schedule reconcile to disk for one workflow. Idempotent and
/// best-effort: errors are logged and swallowed so the workflow save succeeds.
///
/// Upserts preserve an existing job's `history`/`last_run_at`/rollup fields (the
/// desktop status panel reads those) by loading the prior job and only swapping
/// the schedule, name, and `enabled` flag.
pub fn apply_schedule_reconcile(
    workflow_id: &str,
    workflow_name: &str,
    triggers: &[WorkflowTrigger],
) {
    let owned_ids: Vec<String> = sched_store::list_jobs()
        .into_iter()
        .map(|j| j.id)
        .filter(|id| id.starts_with(&schedule_job_prefix(workflow_id)))
        .collect();

    let (upserts, deletes) =
        reconcile_schedule_jobs(workflow_id, workflow_name, triggers, &owned_ids);

    for id in deletes {
        if let Err(e) = sched_store::delete_job(&id) {
            tracing::warn!(job = %id, error = %e, "failed to delete stale workflow schedule job");
        }
    }

    let now = chrono::Utc::now().to_rfc3339();
    for upsert in upserts {
        let job = match sched_store::load_job(&upsert.id) {
            // Preserve history/rollups on an existing job; swap only the parts
            // the declaration owns.
            Ok(mut prior) => {
                prior.name = upsert.name;
                prior.schedule = upsert.schedule;
                prior.enabled = true;
                prior.require_approval = upsert.require_approval;
                prior.updated_at = now.clone();
                prior
            }
            Err(_) => ScheduledJob {
                id: upsert.id,
                name: upsert.name,
                schedule: upsert.schedule,
                target: JobTarget::Workflow {
                    workflow_id: workflow_id.to_string(),
                    input: std::collections::HashMap::new(),
                },
                enabled: true,
                require_approval: upsert.require_approval,
                created_at: now.clone(),
                updated_at: now.clone(),
                last_run_at: None,
                last_outcome: None,
                history: Vec::new(),
            },
        };
        if let Err(e) = sched_store::save_job(&job) {
            tracing::warn!(job = %job.id, error = %e, "failed to save workflow schedule job");
        }
    }
}

/// Tear down every scheduler job owned by a workflow's schedule triggers. Called
/// on workflow delete so a removed workflow stops firing. Best-effort.
pub fn delete_schedule_jobs(workflow_id: &str) {
    let prefix = schedule_job_prefix(workflow_id);
    for job in sched_store::list_jobs() {
        if job.id.starts_with(&prefix) {
            if let Err(e) = sched_store::delete_job(&job.id) {
                tracing::warn!(job = %job.id, error = %e, "failed to delete workflow schedule job on teardown");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schedule_job_id_is_deterministic() {
        assert_eq!(schedule_job_id("wf_abc", 0), "wf-sched-wf_abc-0");
        assert_eq!(schedule_job_id("wf_abc", 3), "wf-sched-wf_abc-3");
        // Stable across calls — the basis for idempotent reconcile.
        assert_eq!(schedule_job_id("wf_abc", 1), schedule_job_id("wf_abc", 1));
    }

    #[test]
    fn reconcile_upserts_cron_and_every() {
        let triggers = vec![
            WorkflowTrigger::Manual,
            WorkflowTrigger::Schedule {
                cron: Some("0 9 * * *".into()),
                every: None,
                require_approval: false,
            },
            WorkflowTrigger::Schedule {
                cron: None,
                every: Some("5m".into()),
                require_approval: false,
            },
        ];
        let (upserts, deletes) = reconcile_schedule_jobs("wf_x", "My WF", &triggers, &[]);
        assert_eq!(deletes.len(), 0);
        assert_eq!(upserts.len(), 2);
        // Ids are keyed by the trigger's index in the list (Manual at 0 is skipped).
        assert_eq!(upserts[0].id, "wf-sched-wf_x-1");
        assert_eq!(
            upserts[0].schedule,
            Schedule::Cron {
                expr: "0 9 * * *".into()
            }
        );
        assert_eq!(upserts[1].id, "wf-sched-wf_x-2");
        assert_eq!(
            upserts[1].schedule,
            Schedule::Every {
                interval: "5m".into()
            }
        );
    }

    #[test]
    fn reconcile_cron_wins_over_every_when_both_set() {
        let triggers = vec![WorkflowTrigger::Schedule {
            cron: Some("* * * * *".into()),
            every: Some("5m".into()),
            require_approval: false,
        }];
        let (upserts, _) = reconcile_schedule_jobs("wf_x", "n", &triggers, &[]);
        assert_eq!(upserts.len(), 1);
        assert_eq!(
            upserts[0].schedule,
            Schedule::Cron {
                expr: "* * * * *".into()
            }
        );
    }

    #[test]
    fn reconcile_skips_empty_schedule_trigger() {
        let triggers = vec![WorkflowTrigger::Schedule {
            cron: Some("   ".into()),
            every: None,
            require_approval: false,
        }];
        let (upserts, _) = reconcile_schedule_jobs("wf_x", "n", &triggers, &[]);
        assert_eq!(upserts.len(), 0);
    }

    #[test]
    fn reconcile_deletes_stale_owned_jobs() {
        // The workflow previously had two schedule jobs; now it declares one.
        let existing = vec!["wf-sched-wf_x-0".to_string(), "wf-sched-wf_x-1".to_string()];
        let triggers = vec![WorkflowTrigger::Schedule {
            cron: Some("0 0 * * *".into()),
            every: None,
            require_approval: false,
        }];
        let (upserts, deletes) = reconcile_schedule_jobs("wf_x", "n", &triggers, &existing);
        // Trigger at index 0 → keep wf-sched-wf_x-0; index-1 job is now stale.
        assert_eq!(upserts.len(), 1);
        assert_eq!(upserts[0].id, "wf-sched-wf_x-0");
        assert_eq!(deletes, vec!["wf-sched-wf_x-1".to_string()]);
    }

    #[test]
    fn reconcile_deletes_all_when_no_schedule_triggers() {
        let existing = vec!["wf-sched-wf_x-0".to_string()];
        let triggers = vec![WorkflowTrigger::Manual];
        let (upserts, deletes) = reconcile_schedule_jobs("wf_x", "n", &triggers, &existing);
        assert_eq!(upserts.len(), 0);
        assert_eq!(deletes, vec!["wf-sched-wf_x-0".to_string()]);
    }
}
