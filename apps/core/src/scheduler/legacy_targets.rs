//! Persisted job targets written by older Cores, and their mapping onto the
//! generic [`JobTarget::AppJob`].
//!
//! This is the ONLY scheduler file that names an app (guarded by
//! `app_boundary_guard::scheduler_names_no_app_outside_the_legacy_shim`). It is
//! shrink-only residue: it stays until no job file or pending approval row can
//! still carry a retired target shape, because `approvals::execute_action`
//! compares a pending row's target against the job's current one.
//!
//! Two layers use it:
//!
//! 1. [`JobTargetWire`] is what `JobTarget` deserializes through
//!    (`#[serde(from = …)]`), so every reader (job files, approval rows, the
//!    HTTP bodies) sees the current form.
//! 2. `store::normalize_persisted_targets` rewrites the job files in place at
//!    startup, using [`legacy_canonical_id`] to keep the canonical job.
//!
//! # Persisted id mapping
//!
//! | Persisted | Becomes | Id |
//! |---|---|---|
//! | `monitor-<mid>.json`, target `{type:"monitor", monitor_id: mid}` | `{type:"app_job", plugin_id:"@ryu/monitors", job_id: mid}`, `owner_app: "@ryu/monitors"` | kept: `monitor-<mid>` (same file, history, `created_at`, `last_*`, side files) |
//! | another live job with that target (a user-created `job_<uuid>`) | deleted by the normalizer when `monitor-<mid>` exists, otherwise swept by the next authoritative reconcile | — |
//! | a tombstoned `monitor-<mid>` | not resurrected; the reconcile recreates the job at `app-<hex32>` with empty history | `app-<hex32 sha256("@ryu/monitors\0" + mid)>` |
//! | a new job from any app | `{type:"app_job", plugin_id, job_id}` | `app-<hex32 sha256(plugin_id + "\0" + job_id)>` |
//!
//! Identity is always the `(plugin_id, job_id)` target pair. Quest jobs
//! (`quest-<qid>`, `{type:"quest"}`) keep their own target until Quests moves
//! onto the generic contract (`docs/app-boundary-extraction-plan.md`, step 6).

use std::collections::HashMap;

use serde::Deserialize;

use super::store::JobTarget;
use crate::plugins::builtins::MONITORS_PLUGIN_ID;

/// Every target shape a persisted job or approval row may carry: the current
/// variants plus the retired per-app ones.
#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum JobTargetWire {
    Workflow {
        workflow_id: String,
        #[serde(default)]
        input: HashMap<String, String>,
    },
    Agent {
        agent_id: String,
        prompt: String,
        #[serde(default)]
        model: Option<String>,
        #[serde(default)]
        conversation_id: Option<String>,
    },
    AppJob {
        plugin_id: String,
        job_id: String,
        #[serde(default)]
        payload: Option<serde_json::Value>,
    },
    ProviderAccount {
        provider_id: String,
        account_id: String,
        prompt: String,
        #[serde(default)]
        model: Option<String>,
    },
    /// Retired: a Monitors check. Maps to the Monitors app's `jobs.run`.
    Monitor {
        monitor_id: String,
    },
    Quest {
        quest_id: String,
    },
    IdentityHealth,
    LearningCycle,
}

impl From<JobTargetWire> for JobTarget {
    fn from(wire: JobTargetWire) -> Self {
        match wire {
            JobTargetWire::Workflow { workflow_id, input } => Self::Workflow { workflow_id, input },
            JobTargetWire::Agent {
                agent_id,
                prompt,
                model,
                conversation_id,
            } => Self::Agent {
                agent_id,
                prompt,
                model,
                conversation_id,
            },
            JobTargetWire::AppJob {
                plugin_id,
                job_id,
                payload,
            } => Self::AppJob {
                plugin_id,
                job_id,
                // An explicit `null` payload is the same as none.
                payload: payload.filter(|payload| !payload.is_null()),
            },
            JobTargetWire::ProviderAccount {
                provider_id,
                account_id,
                prompt,
                model,
            } => Self::ProviderAccount {
                provider_id,
                account_id,
                prompt,
                model,
            },
            JobTargetWire::Monitor { monitor_id } => Self::AppJob {
                plugin_id: MONITORS_PLUGIN_ID.to_owned(),
                job_id: monitor_id,
                payload: None,
            },
            JobTargetWire::Quest { quest_id } => Self::Quest { quest_id },
            JobTargetWire::IdentityHealth => Self::IdentityHealth,
            JobTargetWire::LearningCycle => Self::LearningCycle,
        }
    }
}

/// The job id an older Core wrote for this app job, when there was one: the id
/// the reconcile keeps (with its history) instead of minting `app-<hash>`.
pub(crate) fn legacy_canonical_id(plugin_id: &str, job_id: &str) -> Option<String> {
    (plugin_id == MONITORS_PLUGIN_ID).then(|| format!("monitor-{job_id}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::scheduler::app_jobs::{plan_reconcile, ListedJobs, WantedJob};
    use crate::scheduler::store::{ExecOutcome, ExecRecord, Schedule, ScheduledJob};
    use serde_json::json;

    fn monitor_target(id: &str) -> JobTarget {
        JobTarget::AppJob {
            plugin_id: MONITORS_PLUGIN_ID.to_owned(),
            job_id: id.to_owned(),
            payload: None,
        }
    }

    fn job(id: &str, target: JobTarget, created_at: &str, runs: usize) -> ScheduledJob {
        let mut job = ScheduledJob {
            id: id.to_owned(),
            name: "monitor: Site".to_owned(),
            schedule: Schedule::Every {
                interval: "5m".to_owned(),
            },
            target,
            enabled: true,
            require_approval: false,
            owner_app: Some(MONITORS_PLUGIN_ID.to_owned()),
            owner_user_id: None,
            org_id: None,
            created_at: created_at.to_owned(),
            updated_at: created_at.to_owned(),
            last_run_at: None,
            last_outcome: None,
            history: Vec::new(),
        };
        for n in 0..runs {
            job.record_execution(ExecRecord {
                started_at: format!("2026-01-0{}T00:00:00Z", n + 1),
                finished_at: format!("2026-01-0{}T00:00:01Z", n + 1),
                outcome: ExecOutcome::Success,
                run_id: None,
                error: None,
            });
        }
        job
    }

    fn wanted(id: &str) -> WantedJob {
        WantedJob {
            job_id: id.to_owned(),
            name: "monitor: Site".to_owned(),
            schedule: Schedule::Every {
                interval: "5m".to_owned(),
            },
            enabled: true,
            payload: None,
        }
    }

    #[test]
    fn legacy_monitor_target_deserializes_as_app_job() {
        let target: JobTarget =
            serde_json::from_value(json!({ "type": "monitor", "monitor_id": "m1" })).unwrap();
        assert_eq!(target, monitor_target("m1"));
        assert_eq!(
            serde_json::to_value(&target).unwrap(),
            json!({ "type": "app_job", "plugin_id": "@ryu/monitors", "job_id": "m1" })
        );
    }

    #[test]
    fn only_the_monitors_app_has_a_legacy_canonical_id() {
        assert_eq!(
            legacy_canonical_id(MONITORS_PLUGIN_ID, "m1").as_deref(),
            Some("monitor-m1")
        );
        assert_eq!(legacy_canonical_id("@ryu/other", "m1"), None);
    }

    /// The Monitors app takes part in the Core-tier-only contract: its compiled
    /// manifest is Core tier and provides both job capabilities.
    #[test]
    fn the_compiled_monitors_manifest_is_a_core_tier_job_provider() {
        let manifest = crate::plugin_manifest::PluginManifestLoader::load_builtins()
            .into_iter()
            .find(|manifest| manifest.id == MONITORS_PLUGIN_ID)
            .expect("the Monitors manifest is compiled in");
        assert_eq!(
            crate::plugins::builtins::tier_for_manifest(&manifest),
            crate::plugin_manifest::PluginTier::Core
        );
        for cap in ["jobs.list", "jobs.run"] {
            assert!(
                manifest
                    .provided_capabilities()
                    .iter()
                    .any(|p| p.capability == cap),
                "the Monitors manifest must provide {cap}"
            );
        }
    }

    /// A migrated `monitor-m1` matched by target keeps its id and history.
    #[test]
    fn a_legacy_monitor_job_keeps_its_id_through_the_reconcile() {
        let existing = vec![job("monitor-m1", monitor_target("m1"), "2026-01-01", 3)];
        let plan = plan_reconcile(
            MONITORS_PLUGIN_ID,
            &ListedJobs {
                valid: vec![wanted("m1")],
                invalid: Vec::new(),
            },
            &existing,
            "now",
        );
        assert!(plan.sweep.is_empty(), "{:?}", plan.sweep);
        // Unchanged configuration: nothing to write.
        assert!(plan.upserts.is_empty(), "{:?}", plan.upserts);

        let mut renamed = wanted("m1");
        renamed.name = "monitor: Renamed".to_owned();
        let plan = plan_reconcile(
            MONITORS_PLUGIN_ID,
            &ListedJobs {
                valid: vec![renamed],
                invalid: Vec::new(),
            },
            &existing,
            "now",
        );
        assert_eq!(plan.upserts.len(), 1);
        let upsert = &plan.upserts[0];
        assert_eq!(upsert.id, "monitor-m1");
        assert_eq!(upsert.name, "monitor: Renamed");
        assert_eq!(upsert.history.len(), 3);
        assert_eq!(upsert.created_at, "2026-01-01");
    }

    /// An older user-made duplicate never wins over the canonical legacy id, even
    /// though it was created first.
    #[test]
    fn older_user_duplicate_never_wins() {
        let existing = vec![
            job("job_0123abcd", monitor_target("m1"), "2025-01-01", 1),
            job("monitor-m1", monitor_target("m1"), "2026-01-01", 3),
        ];
        let plan = plan_reconcile(
            MONITORS_PLUGIN_ID,
            &ListedJobs {
                valid: vec![wanted("m1")],
                invalid: Vec::new(),
            },
            &existing,
            "now",
        );
        assert_eq!(plan.sweep, vec!["job_0123abcd".to_owned()]);
        assert!(plan.upserts.iter().all(|job| job.id == "monitor-m1"));
    }

    /// With no canonical legacy job, a duplicate is swept and the job is written
    /// at the hashed id.
    #[test]
    fn without_the_legacy_id_the_job_moves_to_the_hashed_id() {
        let existing = vec![job("job_0123abcd", monitor_target("m1"), "2025-01-01", 1)];
        let plan = plan_reconcile(
            MONITORS_PLUGIN_ID,
            &ListedJobs {
                valid: vec![wanted("m1")],
                invalid: Vec::new(),
            },
            &existing,
            "now",
        );
        assert_eq!(plan.sweep, vec!["job_0123abcd".to_owned()]);
        assert_eq!(plan.upserts.len(), 1);
        assert!(plan.upserts[0].id.starts_with("app-"));
        assert!(plan.upserts[0].history.is_empty());
    }
}
