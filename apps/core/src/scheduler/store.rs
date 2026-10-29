//! File-backed persistence for scheduled jobs.
//!
//! Jobs live under `~/.ryu/scheduled-jobs/<id>.json`. Because they are written
//! to disk, scheduled jobs survive a Core restart: the scheduler reloads every
//! file on boot and resumes ticking. Each job also carries a bounded history of
//! its recent executions so failures are recorded and surfaced.
//!
//! Encryption at rest: every job file (target prompts, inputs, execution
//! history) and every quick-routine pointer is one whole-body `encb:v1:` value
//! under the `workflow-state` content key, bound to its record kind and id (see
//! [`crate::workflow::store::state_codec`]). Every read goes through
//! [`decode_record`]; legacy plaintext files are read as-is and sealed on their
//! next write. Lock files, tombstones, generations and the `.quick` markers
//! (a hash) carry no content and stay plain.

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

/// Max execution-history entries kept per job (newest last).
const MAX_HISTORY: usize = 50;

fn jobs_dir() -> PathBuf {
    #[cfg(test)]
    if let Ok(directory) = TEST_JOBS_DIRECTORY.try_with(Clone::clone) {
        return directory;
    }
    crate::paths::state_path("scheduled-jobs")
}

#[cfg(test)]
tokio::task_local! {
    static TEST_JOBS_DIRECTORY: PathBuf;
}

#[cfg(test)]
pub(crate) async fn with_test_jobs_directory<F: std::future::Future>(
    directory: PathBuf,
    future: F,
) -> F::Output {
    TEST_JOBS_DIRECTORY.scope(directory, future).await
}

/// Carry the caller's test jobs directory (if any) into a future that will run on
/// a spawned task, where task-locals are not inherited.
#[cfg(test)]
pub(crate) fn inherit_test_jobs_directory<F>(
    future: F,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = F::Output> + Send>>
where
    F: std::future::Future + Send + 'static,
    F::Output: Send,
{
    match TEST_JOBS_DIRECTORY.try_with(Clone::clone) {
        Ok(directory) => Box::pin(TEST_JOBS_DIRECTORY.scope(directory, future)),
        Err(_) => Box::pin(future),
    }
}

/// The authorized preflight snapshot, captured without holding a lock across await.
#[derive(Clone)]
pub struct QuickRoutineSnapshot {
    pub destination: Option<String>,
    configuration: Option<serde_json::Value>,
    id: Option<String>,
    generation: u64,
    deleted: bool,
}

#[derive(Serialize, Deserialize)]
struct QuickRoutineSlot {
    agent_id: String,
    owner_user_id: Option<String>,
    org_id: Option<String>,
    id: String,
    #[serde(default)]
    acknowledged: bool,
    #[serde(default)]
    generation: u64,
}

fn invalid(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::InvalidData, message)
}

fn conflict(message: &str) -> std::io::Error {
    std::io::Error::new(std::io::ErrorKind::AlreadyExists, message)
}

fn valid_job_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// Whether `id` is a well-formed persisted job id (the file and lock name).
pub(crate) fn is_valid_job_id(id: &str) -> bool {
    valid_job_id(id)
}

fn job_lock(directory: &std::path::Path, id: &str) -> std::io::Result<std::fs::File> {
    if !valid_job_id(id) {
        return Err(invalid("invalid scheduled job id"));
    }
    let locks = directory.join(".job-locks");
    std::fs::create_dir_all(&locks)?;
    let file = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(locks.join(format!("{id}.lock")))?;
    file.lock()?;
    Ok(file)
}

fn deleted_path(directory: &std::path::Path, id: &str) -> PathBuf {
    directory.join(".job-locks").join(format!("{id}.deleted"))
}

/// Record kinds (AAD purposes) of the sealed scheduler files.
const KIND_JOB: &str = "scheduled-job";
const KIND_QUICK_SLOT: &str = "quick-routine-slot";

/// Seal one record's JSON for disk (fails closed without a key).
fn encode_record(kind: &str, id: &str, json: &[u8]) -> std::io::Result<Vec<u8>> {
    use ryu_durable::CheckpointCodec as _;
    crate::workflow::store::state_codec(kind)?.encode(id, json)
}

/// Open one record's stored bytes back to JSON (legacy plaintext passes).
fn decode_record(kind: &str, id: &str, stored: &[u8]) -> std::io::Result<Vec<u8>> {
    use ryu_durable::CheckpointCodec as _;
    crate::workflow::store::state_codec(kind)?.decode(id, stored)
}

/// Write job `id` (sealed) into `directory`.
fn write_job_file(
    directory: &std::path::Path,
    id: &str,
    job: &ScheduledJob,
) -> std::io::Result<()> {
    let json = serde_json::to_vec_pretty(job)?;
    atomic_write(
        &directory.join(format!("{id}.json")),
        &encode_record(KIND_JOB, id, &json)?,
    )
}

/// Read and open job `id`'s JSON from `path`.
fn read_job_json(path: &std::path::Path, id: &str) -> std::io::Result<Vec<u8>> {
    let bytes = std::fs::read(path)?;
    decode_record(KIND_JOB, id, &bytes)
}

/// Write a quick-routine pointer (sealed; its id is the slot key).
fn write_slot(
    pointer: &std::path::Path,
    key: &str,
    slot: &QuickRoutineSlot,
) -> std::io::Result<()> {
    let json = serde_json::to_vec(slot)?;
    atomic_write(pointer, &encode_record(KIND_QUICK_SLOT, key, &json)?)
}

/// Test helper: read and open the job file `id` in `directory`.
#[cfg(test)]
pub(crate) fn read_job_for_test(directory: &std::path::Path, id: &str) -> ScheduledJob {
    decode_job_for_test(
        id,
        &std::fs::read(directory.join(format!("{id}.json"))).unwrap(),
    )
}

/// Test helper: open job `id` from bytes read off disk.
#[cfg(test)]
pub(crate) fn decode_job_for_test(id: &str, stored: &[u8]) -> ScheduledJob {
    serde_json::from_slice(&decode_record(KIND_JOB, id, stored).unwrap()).unwrap()
}

/// Test helper: read and open a `.quick-routines/<key>.json` pointer.
#[cfg(test)]
pub(crate) fn read_quick_routine_pointer_for_test(pointer: &std::path::Path) -> serde_json::Value {
    let key = pointer.file_stem().and_then(|s| s.to_str()).unwrap();
    let json = decode_record(KIND_QUICK_SLOT, key, &std::fs::read(pointer).unwrap()).unwrap();
    serde_json::from_slice(&json).unwrap()
}

/// Test helper: write a `.quick-routines/<key>.json` pointer sealed, as Core does.
#[cfg(test)]
pub(crate) fn write_quick_routine_pointer_for_test(
    pointer: &std::path::Path,
    slot: &serde_json::Value,
) {
    let key = pointer.file_stem().and_then(|s| s.to_str()).unwrap();
    let json = serde_json::to_vec(slot).unwrap();
    atomic_write(
        pointer,
        &encode_record(KIND_QUICK_SLOT, key, &json).unwrap(),
    )
    .unwrap();
}

fn atomic_write(path: &std::path::Path, bytes: &[u8]) -> std::io::Result<()> {
    use std::io::Write;
    let parent = path
        .parent()
        .ok_or_else(|| invalid("missing routine directory"))?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent)?;
    temporary.write_all(bytes)?;
    temporary.as_file().sync_all()?;
    temporary.persist(path).map_err(|error| error.error)?;
    #[cfg(unix)]
    std::fs::File::open(parent)?.sync_all()?;
    Ok(())
}

fn configuration(job: &ScheduledJob) -> std::io::Result<serde_json::Value> {
    let mut value = serde_json::to_value(job)?;
    if let Some(object) = value.as_object_mut() {
        for field in ["history", "last_run_at", "last_outcome", "updated_at"] {
            object.remove(field);
        }
    }
    Ok(value)
}

fn merge_history(proposed: &mut ScheduledJob, current: &ScheduledJob) {
    proposed.history = current.history.clone();
    proposed.last_run_at = current.last_run_at.clone();
    proposed.last_outcome = current.last_outcome;
}

fn proposed_agent_id(proposed: &ScheduledJob) -> std::io::Result<&str> {
    match &proposed.target {
        JobTarget::Agent { agent_id, .. } => Ok(agent_id),
        _ => Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "quick routine requires an agent target",
        )),
    }
}

fn quick_routine_key(proposed: &ScheduledJob) -> std::io::Result<String> {
    use sha2::{Digest, Sha256};
    Ok(format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&(
            proposed_agent_id(proposed)?,
            &proposed.owner_user_id,
            &proposed.org_id
        ))?)
    ))
}

fn existing_quick_routine_at(
    directory: &std::path::Path,
    proposed: &ScheduledJob,
) -> std::io::Result<(Option<QuickRoutineSlot>, Option<ScheduledJob>)> {
    let agent_id = proposed_agent_id(proposed)?;
    let key = quick_routine_key(proposed)?;
    let pointer = directory
        .join(".quick-routines")
        .join(format!("{key}.json"));
    let slot: Option<QuickRoutineSlot> = match std::fs::read(pointer) {
        Ok(bytes) => Some(serde_json::from_slice(&decode_record(
            KIND_QUICK_SLOT,
            &key,
            &bytes,
        )?)?),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(error) => return Err(error),
    };
    let existing = if let Some(slot) = &slot {
        if !valid_job_id(&slot.id) {
            return Err(invalid("invalid quick routine job id"));
        }
        if slot.agent_id != agent_id
            || slot.owner_user_id != proposed.owner_user_id
            || slot.org_id != proposed.org_id
        {
            return Err(invalid("quick routine slot identity mismatch"));
        }
        match load_job_at(directory, &slot.id) {
            Ok(job) if job.id == slot.id => {
                let marker = std::fs::read_to_string(
                    directory
                        .join(".job-locks")
                        .join(format!("{}.quick", slot.id)),
                )
                .map_err(|_| invalid("quick routine marker missing"))?;
                if marker != key {
                    return Err(invalid("quick routine marker mismatch"));
                }
                Some(job)
            }
            Ok(_) => return Err(invalid("quick routine job id mismatch")),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error),
        }
    } else {
        let mut candidates = list_jobs_at(directory).into_iter().filter(|job| job.name.ends_with(" (scheduled)") && job.owner_user_id == proposed.owner_user_id && job.org_id == proposed.org_id && matches!(&job.target, JobTarget::Agent { agent_id: existing_agent, .. } if existing_agent == agent_id));
        let candidate = candidates.next();
        if candidates.next().is_some() {
            return Err(conflict("multiple legacy quick routines require review"));
        }
        candidate
    };
    if let Some(job) = &existing {
        if job.owner_user_id != proposed.owner_user_id
            || job.org_id != proposed.org_id
            || !matches!(&job.target, JobTarget::Agent { agent_id: existing_agent, .. } if existing_agent == agent_id)
        {
            return Err(invalid("quick routine target identity mismatch"));
        }
    }
    Ok((slot, existing))
}

pub async fn quick_routine_snapshot(
    proposed: &ScheduledJob,
) -> std::io::Result<QuickRoutineSnapshot> {
    let directory = jobs_dir();
    let proposed = proposed.clone();
    tokio::task::spawn_blocking(move || {
        let (slot, existing) = existing_quick_routine_at(&directory, &proposed)?;
        let id = slot
            .as_ref()
            .map(|slot| slot.id.as_str())
            .or_else(|| existing.as_ref().map(|job| job.id.as_str()));
        let _lock = id.map(|id| job_lock(&directory, id)).transpose()?;
        let (slot, existing) = existing_quick_routine_at(&directory, &proposed)?;
        let deleted = slot.as_ref().is_some_and(|slot| {
            deleted_path(&directory, &slot.id).exists() || (slot.acknowledged && existing.is_none())
        });
        let destination = match existing.as_ref().map(|job| &job.target) {
            Some(JobTarget::Agent {
                conversation_id, ..
            }) => conversation_id.clone(),
            _ => None,
        };
        Ok(QuickRoutineSnapshot {
            id: slot
                .as_ref()
                .map(|slot| slot.id.clone())
                .or_else(|| existing.as_ref().map(|job| job.id.clone())),
            destination,
            configuration: existing.as_ref().map(configuration).transpose()?,
            generation: slot.as_ref().map_or(0, |slot| slot.generation),
            deleted,
        })
    })
    .await
    .map_err(std::io::Error::other)?
}

/// Slot lock precedes the shared job lock; neither spans an await.
pub async fn upsert_quick_routine(
    proposed: ScheduledJob,
    conversation_supplied: bool,
    snapshot: QuickRoutineSnapshot,
) -> std::io::Result<ScheduledJob> {
    let directory = jobs_dir();
    tokio::task::spawn_blocking(move || {
        upsert_quick_routine_at(directory, proposed, conversation_supplied, snapshot)
    })
    .await
    .map_err(std::io::Error::other)?
}

fn upsert_quick_routine_at(
    directory: PathBuf,
    mut proposed: ScheduledJob,
    conversation_supplied: bool,
    snapshot: QuickRoutineSnapshot,
) -> std::io::Result<ScheduledJob> {
    let key = quick_routine_key(&proposed)?;
    let slots = directory.join(".quick-routines");
    std::fs::create_dir_all(&slots)?;
    let slot_lock = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(slots.join(format!("{key}.lock")))?;
    slot_lock.lock()?;
    let (slot, existing) = existing_quick_routine_at(&directory, &proposed)?;
    let current_id = slot
        .as_ref()
        .map(|slot| slot.id.clone())
        .or_else(|| existing.map(|job| job.id))
        .or_else(|| snapshot.id.clone())
        .unwrap_or_else(|| proposed.id.clone());
    let _old_job_lock = job_lock(&directory, &current_id)?;
    let (slot, existing) = existing_quick_routine_at(&directory, &proposed)?;
    let current_generation = slot.as_ref().map_or(0, |slot| slot.generation);
    let deleted = deleted_path(&directory, &current_id).exists()
        || slot
            .as_ref()
            .is_some_and(|slot| slot.acknowledged && existing.is_none());
    let generation = if deleted {
        if !snapshot.deleted || current_generation != snapshot.generation {
            return Err(conflict("quick routine was deleted; retry creation"));
        }
        current_generation
            .checked_add(1)
            .ok_or_else(|| invalid("quick routine generation exhausted"))?
    } else {
        if current_generation != snapshot.generation
            && !(snapshot.deleted && snapshot.generation.checked_add(1) == Some(current_generation))
        {
            return Err(conflict("quick routine changed during validation; retry"));
        }
        proposed.id = current_id.clone();
        current_generation
    };
    if !deleted {
        if let Some(existing) = existing {
            if snapshot
                .configuration
                .as_ref()
                .is_some_and(|expected| configuration(&existing).ok().as_ref() != Some(expected))
            {
                return Err(conflict("quick routine changed during validation; retry"));
            }
            proposed.id = existing.id.clone();
            proposed.created_at = existing.created_at.clone();
            merge_history(&mut proposed, &existing);
            proposed.owner_app = existing.owner_app;
            if !conversation_supplied {
                if let (
                    JobTarget::Agent {
                        conversation_id, ..
                    },
                    JobTarget::Agent {
                        conversation_id: previous,
                        ..
                    },
                ) = (&mut proposed.target, existing.target)
                {
                    if previous != snapshot.destination {
                        return Err(conflict("quick routine changed during validation; retry"));
                    }
                    *conversation_id = previous;
                }
            }
        }
    }
    let _new_job_lock = if proposed.id != current_id {
        Some(job_lock(&directory, &proposed.id)?)
    } else {
        None
    };
    let pointer = slots.join(format!("{key}.json"));
    let mut intent = QuickRoutineSlot {
        agent_id: proposed_agent_id(&proposed)?.to_owned(),
        owner_user_id: proposed.owner_user_id.clone(),
        org_id: proposed.org_id.clone(),
        id: proposed.id.clone(),
        acknowledged: false,
        generation,
    };
    if let Some(slot) = &slot {
        if slot.id == intent.id {
            intent.acknowledged = slot.acknowledged;
        }
    }
    write_slot(&pointer, &key, &intent)?;
    atomic_write(
        &directory
            .join(".job-locks")
            .join(format!("{}.quick", proposed.id)),
        key.as_bytes(),
    )?;
    write_job_file(&directory, &proposed.id, &proposed)?;
    intent.acknowledged = true;
    write_slot(&pointer, &key, &intent)?;
    Ok(proposed)
}

/// Apply a validated configuration only if its authorized snapshot is current;
/// append-only execution records merge from the fresh locked row.
pub async fn update_job_if_current(
    expected: ScheduledJob,
    mut proposed: ScheduledJob,
) -> std::io::Result<ScheduledJob> {
    if proposed.id != expected.id {
        return Err(invalid("routine update id mismatch"));
    }
    let directory = jobs_dir();
    tokio::task::spawn_blocking(move || {
        let _lock = job_lock(&directory, &expected.id)?;
        let current = load_job_at(&directory, &expected.id)?;
        if configuration(&current)? != configuration(&expected)? {
            return Err(conflict("routine changed during validation; retry"));
        }
        merge_history(&mut proposed, &current);
        write_job_file(&directory, &proposed.id, &proposed)?;
        Ok(proposed)
    })
    .await
    .map_err(std::io::Error::other)?
}

/// What a scheduled job runs when it fires.
///
/// Deserialized through [`super::legacy_targets::JobTargetWire`], which also
/// accepts the retired per-app target shapes persisted by older Cores (job files
/// and pending approval rows) and maps them onto [`JobTarget::AppJob`].
/// Serialization is the derived, current wire form.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    from = "super::legacy_targets::JobTargetWire"
)]
pub enum JobTarget {
    /// Run a persisted workflow by id, with an optional initial input map.
    Workflow {
        workflow_id: String,
        #[serde(default)]
        input: std::collections::HashMap<String, String>,
    },
    /// Run an agent: a single chat turn against the given agent id.
    ///
    /// `model` optionally pins the model for *this turn only*, exactly as the
    /// composer's model picker does — the agent's stored binding is otherwise
    /// untouched. Absent, the agent runs on whatever it is configured with.
    /// This exists because a scheduled turn is frequently a cheap errand
    /// (a keep-alive ping, a status poll) that has no business burning the
    /// agent's flagship model.
    Agent {
        agent_id: String,
        prompt: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        /// Existing conversation to append to. `None` means every firing gets
        /// its own new persistent conversation.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        conversation_id: Option<String>,
    },
    /// Run one job an app owns, through the generic `jobs.run` fan-out capability
    /// of `plugin_id` (`crate::scheduler::app_jobs`). Core holds no knowledge of
    /// what the job does: the app lists its jobs through `jobs.list` and Core
    /// reconciles one of these per listed job, so app jobs ride the same tick loop
    /// as workflows and agents. Reconcile-owned: never created or retargeted
    /// through `/heartbeat/jobs`.
    AppJob {
        /// The providing app's manifest id.
        plugin_id: String,
        /// The job's id inside that app (its `jobs.list` entry id).
        job_id: String,
        /// Optional app-defined object posted back in the `jobs.run` body.
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload: Option<serde_json::Value>,
    },
    /// Send one minimal turn on exactly one saved subscription account of a
    /// provider pool (`claude-pro-max`, `chatgpt`), bypassing the pool's own
    /// account selection. This is how a warmup opens a *specific* login's
    /// rolling usage window when a provider holds several.
    ProviderAccount {
        provider_id: String,
        account_id: String,
        prompt: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
    },
    /// Run one quest detection pass (gather Shadow context → judge → suggest or
    /// auto-complete). Frozen residue (`crate::scheduler::legacy_quest_jobs`),
    /// retired once Quests moves onto [`JobTarget::AppJob`]; created
    /// automatically for every open quest so it rides the same tick loop.
    Quest { quest_id: String },
    /// Re-validate every `AUTHENTICATED` Identity Vault connection and flip the
    /// stale ones to `NEEDS_AUTH`. Backed by the health engine
    /// ([`crate::identity::health`]); a single fixed-id job ensured at startup
    /// (there is no per-connection CRUD hook), so it rides the same tick loop.
    IdentityHealth,
    /// Run one continual-learning cycle (sweep conversations → PRM-score → reward-
    /// filter → dispatch a retrain from the original base). Backed by
    /// [`crate::learning`]; a single fixed-id job ensured at startup that no-ops
    /// unless the user opted in (and, if a sleep window is set, only fires within
    /// it). Rides the same tick loop as the others.
    LearningCycle,
}

/// The schedule on which a job fires.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Schedule {
    /// Classic 5-field cron expression.
    ///
    /// Evaluated in UTC unless `tz` names an IANA zone (`"Europe/Lisbon"`), in
    /// which case the expression is read against that zone's wall clock. Absent
    /// `tz` is the historical behaviour, so every job written before this field
    /// existed keeps firing exactly when it did.
    ///
    /// The zone is stored, not folded into the expression, because folding is
    /// only correct until the next DST transition: "05:00 local" is a different
    /// UTC hour in summer than in winter, and a schedule chosen to sit a fixed
    /// distance from a rolling rate-limit boundary cannot absorb that drift.
    Cron {
        expr: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        tz: Option<String>,
    },
    /// Fixed interval, e.g. `30s`, `5m`, `1h` (parsed by `humantime`).
    Every { interval: String },
}

/// Outcome of a single job execution.
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecOutcome {
    Success,
    Failure,
}

/// One recorded execution of a job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecRecord {
    pub started_at: String,
    pub finished_at: String,
    pub outcome: ExecOutcome,
    /// Workflow run id when the target was a workflow.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub run_id: Option<String>,
    /// Error message when the outcome was a failure.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// A persisted scheduled job.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ScheduledJob {
    pub id: String,
    pub name: String,
    pub schedule: Schedule,
    pub target: JobTarget,
    /// When false, the scheduler skips this job without removing it.
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// When true, a due firing does not run the target directly — it raises a
    /// human-in-the-loop approval request ([`crate::approvals`]) and runs only
    /// once the user approves. Off by default (autonomous), so existing jobs are
    /// unchanged.
    #[serde(default)]
    pub require_approval: bool,
    /// The manifest id of the App that created this job (`@ryu/warmup`), when
    /// one did.
    ///
    /// Scheduler jobs outlive the surface that wrote them: they are files on
    /// disk driven by Core's own tick loop, so a job created through an App's UI
    /// keeps firing after that App is disabled or uninstalled — at which point
    /// the user has no affordance left to stop it. Recording the owner lets the
    /// tick loop treat "the owning App is off" as "its automations are off",
    /// which is the only reading under which disabling an App actually means
    /// something. `None` (a job Core or the desktop owns) is never gated.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_app: Option<String>,
    /// Verified user who owns this routine on a shared node. Absent on personal
    /// nodes and legacy/system jobs.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub owner_user_id: Option<String>,
    /// Organization that owns this routine on a shared node.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub org_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    /// ISO timestamp of the last time this job fired (success or failure).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_run_at: Option<String>,
    /// Outcome of the most recent execution.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_outcome: Option<ExecOutcome>,
    /// Bounded execution history, oldest first.
    #[serde(default)]
    pub history: Vec<ExecRecord>,
}

fn default_true() -> bool {
    true
}

impl ScheduledJob {
    /// Append an execution record, updating the rollup fields and trimming the
    /// history to its bound.
    pub fn record_execution(&mut self, record: ExecRecord) {
        self.last_run_at = Some(record.finished_at.clone());
        self.last_outcome = Some(record.outcome);
        self.history.push(record);
        if self.history.len() > MAX_HISTORY {
            let overflow = self.history.len() - MAX_HISTORY;
            self.history.drain(0..overflow);
        }
        self.updated_at = chrono::Utc::now().to_rfc3339();
    }
}

/// Persist (create or overwrite) a scheduled job.
pub fn save_job(job: &ScheduledJob) -> std::io::Result<()> {
    let directory = jobs_dir();
    let _lock = job_lock(&directory, &job.id)?;
    if deleted_path(&directory, &job.id).exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "routine was deleted",
        ));
    }
    let mut proposed = job.clone();
    match load_job_at(&directory, &job.id) {
        Ok(current) => {
            if current.created_at != job.created_at {
                return Err(conflict("routine generation changed; reload before saving"));
            }
            merge_history(&mut proposed, &current);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    write_job_file(&directory, &job.id, &proposed)
}

/// Load a scheduled job by id.
pub fn load_job(id: &str) -> std::io::Result<ScheduledJob> {
    load_job_at(&jobs_dir(), id)
}

fn load_job_at(directory: &std::path::Path, id: &str) -> std::io::Result<ScheduledJob> {
    if deleted_path(directory, id).exists() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::NotFound,
            "routine was deleted",
        ));
    }
    let json = read_job_json(&directory.join(format!("{id}.json")), id)?;
    serde_json::from_slice(&json)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))
}

/// Record a finished run against the current configuration, not the snapshot
/// captured before executing agent tools. A run may reschedule or delete itself.
pub fn append_execution(id: &str, record: ExecRecord) -> std::io::Result<()> {
    append_execution_at(&jobs_dir().join(format!("{id}.json")), record)
}

fn append_execution_at(path: &std::path::Path, record: ExecRecord) -> std::io::Result<()> {
    let directory = path
        .parent()
        .ok_or_else(|| invalid("missing job directory"))?;
    let id = path
        .file_stem()
        .and_then(|id| id.to_str())
        .ok_or_else(|| invalid("invalid job path"))?;
    let _lock = job_lock(directory, id)?;
    if deleted_path(directory, id).exists() {
        return Ok(());
    }
    let bytes = match read_job_json(path, id) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    let mut current: ScheduledJob = serde_json::from_slice(&bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    current.record_execution(record);
    write_job_file(directory, id, &current)
}

/// List all persisted scheduled jobs.
pub fn list_jobs() -> Vec<ScheduledJob> {
    list_jobs_at(&jobs_dir())
}

fn list_jobs_at(directory: &std::path::Path) -> Vec<ScheduledJob> {
    let Ok(entries) = std::fs::read_dir(directory) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    let mut unreadable = 0u64;
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        if let Some(id) = path.file_stem().and_then(|id| id.to_str()) {
            match load_job_at(directory, id) {
                Ok(job) => out.push(job),
                Err(error) if error.kind() == std::io::ErrorKind::InvalidData => unreadable += 1,
                Err(_) => {}
            }
        }
    }
    if unreadable > 0 {
        tracing::warn!(
            unreadable,
            "scheduler: job files skipped because they do not open or parse"
        );
    }
    out.sort_by(|a, b| a.created_at.cmp(&b.created_at));
    out
}

/// Delete a scheduled job by id. Returns `true` when a file was removed.
pub fn delete_job(id: &str) -> std::io::Result<bool> {
    delete_job_at(&jobs_dir(), id)
}

fn delete_job_at(directory: &std::path::Path, id: &str) -> std::io::Result<bool> {
    let _lock = job_lock(directory, id)?;
    let path = directory.join(format!("{id}.json"));
    let exists = path.exists();
    if !exists {
        return Ok(false);
    }
    // Minimal tombstone only: never retain the deleted prompt/history. Once the
    // marker commits, reads and execution completion fail closed even if unlink
    // is refused. Retrying deletion finishes unlinking the same live path.
    atomic_write(&deleted_path(directory, id), b"deleted")?;
    std::fs::remove_file(path)?;
    #[cfg(unix)]
    std::fs::File::open(directory)?.sync_all()?;
    Ok(true)
}

pub async fn delete_job_async(id: String) -> std::io::Result<bool> {
    let directory = jobs_dir();
    tokio::task::spawn_blocking(move || delete_job_at(&directory, &id))
        .await
        .map_err(std::io::Error::other)?
}

/// A refused unlink can be retried after authorizing the still-present record;
/// ordinary reads keep it hidden as soon as its deletion marker commits.
pub fn load_job_for_delete(id: &str) -> std::io::Result<ScheduledJob> {
    if !valid_job_id(id) {
        return Err(invalid("invalid scheduled job id"));
    }
    let bytes = read_job_json(&jobs_dir().join(format!("{id}.json")), id)?;
    serde_json::from_slice(&bytes).map_err(|error| invalid(&error.to_string()))
}

#[derive(Debug)]
pub struct ExecutionClaim {
    directory: PathBuf,
    id: String,
    generation: String,
}

#[derive(Serialize, Deserialize)]
struct RecreationIntent {
    generation: String,
    created_at: String,
}

fn generation_at(directory: &std::path::Path, job: &ScheduledJob) -> std::io::Result<String> {
    let path = directory
        .join(".job-locks")
        .join(format!("{}.generation", job.id));
    match std::fs::read_to_string(path) {
        Ok(generation) if uuid::Uuid::parse_str(&generation).is_ok() => Ok(generation),
        Ok(_) => Err(invalid("invalid routine generation")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            Ok(format!("legacy:{}", job.created_at))
        }
        Err(error) => Err(error),
    }
}

/// Bind execution to the exact authorized configuration and durable identity
/// before handing off work. A stale or deleted snapshot cannot execute.
pub async fn capture_execution(job: &ScheduledJob) -> std::io::Result<ExecutionClaim> {
    let directory = jobs_dir();
    let expected = job.clone();
    tokio::task::spawn_blocking(move || {
        let _lock = job_lock(&directory, &expected.id)?;
        let current = load_job_at(&directory, &expected.id)?;
        if configuration(&current)? != configuration(&expected)? {
            return Err(conflict(
                "routine changed before execution; reload and retry",
            ));
        }
        Ok(ExecutionClaim {
            generation: generation_at(&directory, &current)?,
            directory,
            id: expected.id,
        })
    })
    .await
    .map_err(std::io::Error::other)?
}

/// Completion of an earlier identity is ignored, including fixed-id recreation.
pub async fn append_execution_claim(
    claim: ExecutionClaim,
    record: ExecRecord,
) -> std::io::Result<bool> {
    tokio::task::spawn_blocking(move || {
        let _lock = job_lock(&claim.directory, &claim.id)?;
        let mut current = match load_job_at(&claim.directory, &claim.id) {
            Ok(current) => current,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(error),
        };
        if generation_at(&claim.directory, &current)? != claim.generation {
            return Ok(false);
        }
        current.record_execution(record);
        write_job_file(&claim.directory, &claim.id, &current)?;
        Ok(true)
    })
    .await
    .map_err(std::io::Error::other)?
}

/// Only authoritative declaration reconciliation may recreate a fixed id.
/// Ordinary snapshot saves continue to refuse deleted identities.
pub fn recreate_authoritative_job(job: &ScheduledJob) -> std::io::Result<()> {
    let directory = jobs_dir();
    let _lock = job_lock(&directory, &job.id)?;
    let deleted = deleted_path(&directory, &job.id);
    let mut proposed = job.clone();
    if !deleted.exists() {
        match load_job_at(&directory, &job.id) {
            Ok(current) => {
                proposed.created_at = current.created_at.clone();
                merge_history(&mut proposed, &current);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error),
        }
        return write_job_file(&directory, &job.id, &proposed);
    }
    let intent_path = directory
        .join(".job-locks")
        .join(format!("{}.recreate", job.id));
    let intent: RecreationIntent = match std::fs::read(&intent_path) {
        Ok(bytes) => serde_json::from_slice(&bytes)?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let intent = RecreationIntent {
                generation: uuid::Uuid::new_v4().to_string(),
                created_at: chrono::Utc::now().to_rfc3339(),
            };
            atomic_write(&intent_path, &serde_json::to_vec(&intent)?)?;
            intent
        }
        Err(error) => return Err(error),
    };
    if uuid::Uuid::parse_str(&intent.generation).is_err()
        || chrono::DateTime::parse_from_rfc3339(&intent.created_at).is_err()
    {
        return Err(invalid("invalid routine recreation intent"));
    }
    proposed.created_at = intent.created_at;
    proposed.updated_at = chrono::Utc::now().to_rfc3339();
    proposed.history.clear();
    proposed.last_run_at = None;
    proposed.last_outcome = None;
    atomic_write(
        &directory
            .join(".job-locks")
            .join(format!("{}.generation", job.id)),
        intent.generation.as_bytes(),
    )?;
    write_job_file(&directory, &job.id, &proposed)?;
    // Clear pending metadata before making the new identity visible, so an
    // interrupted cleanup cannot reuse a prior generation on another recreation.
    std::fs::remove_file(intent_path)?;
    std::fs::remove_file(deleted)?;
    #[cfg(unix)]
    std::fs::File::open(directory.join(".job-locks"))?.sync_all()?;
    Ok(())
}

/// Change only enabled, using the fresh locked row. A retargeted job is left alone.
pub fn disable_job_if_target(id: &str, expected_target: &JobTarget) -> std::io::Result<()> {
    let directory = jobs_dir();
    let _lock = job_lock(&directory, id)?;
    let mut current = match load_job_at(&directory, id) {
        Ok(current) => current,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if &current.target != expected_target || !current.enabled {
        return Ok(());
    }
    current.enabled = false;
    current.updated_at = chrono::Utc::now().to_rfc3339();
    write_job_file(&directory, id, &current)
}

/// Rewrite persisted jobs whose target was written in a retired per-app shape
/// into the current [`JobTarget::AppJob`] form, in place. Run once at startup,
/// before the reconcile loop and the scheduler tick start.
///
/// Idempotent: a second run writes and deletes nothing. For every app job it
/// forces `owner_app` to the target's app (overwriting a request-supplied
/// value) and rewrites the file only when its `target` / `owner_app` differ from
/// the re-serialized form. Everything else is preserved: the id and file name,
/// name, schedule, enabled state, `require_approval`, `created_at`,
/// `last_run_at`, `last_outcome`, the bounded history, and the `.generation` /
/// `.quick` side files. A tombstoned job is never resurrected: a file it left
/// behind (an interrupted delete) is removed and counted.
///
/// The same pass seals every job file and quick-routine pointer still stored as
/// legacy plaintext (same JSON, rewritten sealed; not counted in the return
/// value) and removes temporary files crashed writes left behind.
///
/// When the job at a target's canonical legacy id
/// ([`super::legacy_targets::legacy_canonical_id`]) exists, every other live
/// job with the same target pair (for example a user-created `job_<uuid>`
/// duplicate) is deleted, so the canonical job and its history are the one that
/// keeps ticking. Returns the number of files rewritten or deleted.
pub fn normalize_persisted_targets() -> std::io::Result<usize> {
    normalize_persisted_targets_at(&jobs_dir())
}

fn normalize_persisted_targets_at(directory: &std::path::Path) -> std::io::Result<usize> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let mut changed = 0;
    // Files that were legacy plaintext and are now sealed (content unchanged).
    let mut sealed = 0;
    // Files of deleted jobs whose unlink did not complete (now removed).
    let mut removed = 0;
    // (job id, plugin id, app job id) of every live app job, after rewriting.
    let mut app_jobs: Vec<(String, String, String)> = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(id) = path
            .file_stem()
            .and_then(|id| id.to_str())
            .map(str::to_owned)
        else {
            continue;
        };
        if !valid_job_id(&id) {
            continue;
        }
        match normalize_one_at(directory, &id) {
            Ok(Normalized::Removed) => {
                changed += 1;
                removed += 1;
            }
            Ok(Normalized::Kept {
                sealed: sealed_now,
                app: Some((rewritten, plugin_id, job_id)),
            }) => {
                changed += usize::from(rewritten);
                sealed += usize::from(sealed_now && !rewritten);
                app_jobs.push((id, plugin_id, job_id));
            }
            Ok(Normalized::Kept {
                sealed: sealed_now,
                app: None,
            }) => sealed += usize::from(sealed_now),
            Err(error) => {
                tracing::warn!("scheduler: could not normalize persisted job '{id}': {error}");
            }
        }
    }
    sealed += seal_quick_routine_pointers_at(directory);
    let orphans = remove_orphaned_job_temps_at(directory);
    if sealed > 0 {
        tracing::info!(
            files = sealed,
            "scheduler: sealed legacy plaintext job files"
        );
    }
    if removed > 0 {
        tracing::info!(
            files = removed,
            "scheduler: removed leftover files of deleted jobs"
        );
    }
    if orphans > 0 {
        tracing::info!(
            files = orphans,
            "scheduler: removed orphaned temporary job files"
        );
    }
    let mut duplicates = Vec::new();
    for (id, plugin_id, job_id) in &app_jobs {
        let Some(canonical) = super::legacy_targets::legacy_canonical_id(plugin_id, job_id) else {
            continue;
        };
        let canonical_has_same_target = canonical != *id
            && app_jobs
                .iter()
                .any(|(other, p, j)| *other == canonical && p == plugin_id && j == job_id);
        if canonical_has_same_target {
            duplicates.push(id.clone());
        }
    }
    for id in duplicates {
        // Locks are per job and none is held here (each was released above).
        if delete_job_at(directory, &id)? {
            changed += 1;
        }
    }
    Ok(changed)
}

/// How old a temporary file in the jobs folders must be before the start-up
/// pass treats it as a crash orphan (a write in flight lasts milliseconds).
const ORPHAN_TEMP_MIN_AGE: std::time::Duration = std::time::Duration::from_secs(60);

/// What [`normalize_one_at`] did with one job file.
enum Normalized {
    /// The job was tombstoned but its file survived (an unlink that failed or a
    /// crash inside [`delete_job_at`]); the delete was finished.
    Removed,
    /// The file stays. `sealed` is `true` when it was plaintext and is now
    /// sealed; `app` is `Some((rewritten, plugin, job))` for an app job, `None`
    /// for anything else (or a missing file).
    Kept {
        sealed: bool,
        app: Option<(bool, String, String)>,
    },
}

/// Normalize one job file under its lock, sealing it when it is still legacy
/// plaintext, and finishing the delete of a tombstoned job whose file is still
/// present (its prompt and history must not stay on disk, sealed or not).
fn normalize_one_at(directory: &std::path::Path, id: &str) -> std::io::Result<Normalized> {
    let _lock = job_lock(directory, id)?;
    let path = directory.join(format!("{id}.json"));
    if deleted_path(directory, id).exists() {
        // Readers already treat the job as deleted. A recreation always checks
        // the tombstone first and writes a fresh file, so removing this one
        // loses nothing visible.
        return match std::fs::remove_file(&path) {
            Ok(()) => {
                #[cfg(unix)]
                std::fs::File::open(directory)?.sync_all()?;
                Ok(Normalized::Removed)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(Normalized::Kept {
                sealed: false,
                app: None,
            }),
            Err(error) => Err(error),
        };
    }
    let stored = match std::fs::read(&path) {
        Ok(stored) => stored,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Normalized::Kept {
                sealed: false,
                app: None,
            });
        }
        Err(error) => return Err(error),
    };
    let plaintext = !ryu_durable::SealingCodec::is_sealed(&stored);
    let bytes = decode_record(KIND_JOB, id, &stored)?;
    let raw: serde_json::Value = serde_json::from_slice(&bytes)
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let mut job: ScheduledJob = serde_json::from_value(raw.clone())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidData, error))?;
    let app_job = match &job.target {
        JobTarget::AppJob {
            plugin_id, job_id, ..
        } => Some((plugin_id.clone(), job_id.clone())),
        _ => None,
    };
    let Some((plugin_id, job_id)) = app_job else {
        if plaintext {
            // Seal the same JSON, byte for byte (prompts, inputs and history
            // are user content).
            atomic_write(&path, &encode_record(KIND_JOB, id, &bytes)?)?;
        }
        return Ok(Normalized::Kept {
            sealed: plaintext,
            app: None,
        });
    };
    job.owner_app = Some(plugin_id.clone());
    let target = serde_json::to_value(&job.target)?;
    let owner = serde_json::Value::String(plugin_id.clone());
    let current = raw.get("target") == Some(&target) && raw.get("owner_app") == Some(&owner);
    if !current {
        write_job_file(directory, id, &job)?;
    } else if plaintext {
        atomic_write(&path, &encode_record(KIND_JOB, id, &bytes)?)?;
    }
    Ok(Normalized::Kept {
        sealed: plaintext,
        app: Some((!current, plugin_id, job_id)),
    })
}

/// Seal every `.quick-routines/<key>.json` pointer still stored as legacy
/// plaintext, under its slot lock (the lock every pointer write holds).
/// Returns how many were sealed.
fn seal_quick_routine_pointers_at(directory: &std::path::Path) -> usize {
    let slots = directory.join(".quick-routines");
    let Ok(entries) = std::fs::read_dir(&slots) else {
        return 0;
    };
    let mut sealed = 0;
    for entry in entries.flatten() {
        let pointer = entry.path();
        if pointer.extension().and_then(|e| e.to_str()) != Some("json") {
            continue;
        }
        let Some(key) = pointer
            .file_stem()
            .and_then(|stem| stem.to_str())
            .filter(|key| valid_job_id(key))
            .map(str::to_owned)
        else {
            continue;
        };
        let result = (|| -> std::io::Result<bool> {
            let slot_lock = std::fs::OpenOptions::new()
                .create(true)
                .truncate(false)
                .read(true)
                .write(true)
                .open(slots.join(format!("{key}.lock")))?;
            slot_lock.lock()?;
            let stored = std::fs::read(&pointer)?;
            if ryu_durable::SealingCodec::is_sealed(&stored) {
                return Ok(false);
            }
            // Only a pointer that parses is rewritten (same JSON, sealed).
            let _: QuickRoutineSlot = serde_json::from_slice(&stored)?;
            atomic_write(&pointer, &encode_record(KIND_QUICK_SLOT, &key, &stored)?)?;
            Ok(true)
        })();
        match result {
            Ok(true) => sealed += 1,
            Ok(false) => {}
            Err(error) => tracing::warn!(
                "scheduler: quick-routine pointer {} was not sealed: {error}",
                pointer.display()
            ),
        }
    }
    sealed
}

/// Remove the temporary files crashed writes left in the jobs folder and its
/// quick-routine folder (each a full copy of a job or pointer, plaintext before
/// sealing). Returns how many were removed.
fn remove_orphaned_job_temps_at(directory: &std::path::Path) -> usize {
    ryu_durable::remove_orphaned_temp_files(directory, ORPHAN_TEMP_MIN_AGE)
        + ryu_durable::remove_orphaned_temp_files(
            &directory.join(".quick-routines"),
            ORPHAN_TEMP_MIN_AGE,
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record(outcome: ExecOutcome, at: &str) -> ExecRecord {
        ExecRecord {
            started_at: at.to_string(),
            finished_at: at.to_string(),
            outcome,
            run_id: None,
            error: None,
        }
    }

    fn job() -> ScheduledJob {
        ScheduledJob {
            id: "j1".into(),
            name: "n".into(),
            schedule: Schedule::Cron {
                expr: "* * * * *".into(),
                tz: None,
            },
            target: JobTarget::IdentityHealth,
            enabled: true,
            require_approval: false,
            owner_app: None,
            owner_user_id: None,
            org_id: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
            last_run_at: None,
            last_outcome: None,
            history: Vec::new(),
        }
    }

    #[test]
    fn completion_preserves_rescheduled_config_and_does_not_resurrect_deleted_job() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("job.json");
        let mut updated = job();
        updated.schedule = Schedule::Every {
            interval: "6h".into(),
        };
        updated.enabled = false;
        updated.target = JobTarget::Agent {
            agent_id: "watch".into(),
            prompt: "Recheck after reset".into(),
            model: Some("low-cost-model".into()),
            conversation_id: None,
        };
        std::fs::write(&path, serde_json::to_vec(&updated).unwrap()).unwrap();
        append_execution_at(&path, record(ExecOutcome::Success, "2026-09-11T00:00:00Z")).unwrap();
        let saved = read_job_for_test(dir.path(), "job");
        assert_eq!(saved.schedule, updated.schedule);
        assert_eq!(saved.target, updated.target);
        assert!(!saved.enabled);
        assert_eq!(saved.history.len(), 1);
        std::fs::remove_file(&path).unwrap();
        append_execution_at(&path, record(ExecOutcome::Success, "2026-09-11T00:01:00Z")).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn record_execution_updates_rollups_and_appends() {
        let mut j = job();
        j.record_execution(record(ExecOutcome::Failure, "2026-02-02T00:00:00Z"));
        assert_eq!(j.last_run_at.as_deref(), Some("2026-02-02T00:00:00Z"));
        assert_eq!(j.last_outcome, Some(ExecOutcome::Failure));
        assert_eq!(j.history.len(), 1);
        // updated_at is refreshed off the wall clock, away from the seed value.
        assert_ne!(j.updated_at, "2026-01-01T00:00:00Z");
    }

    #[test]
    fn record_execution_trims_history_to_bound_keeping_newest() {
        let mut j = job();
        for i in 0..(MAX_HISTORY + 10) {
            j.record_execution(record(
                ExecOutcome::Success,
                &format!("2026-03-{:02}T00:00:00Z", i % 28 + 1),
            ));
        }
        assert_eq!(j.history.len(), MAX_HISTORY);
        // The oldest entries were drained from the front — the last push is retained.
        assert_eq!(j.last_outcome, Some(ExecOutcome::Success));
    }

    #[test]
    fn job_target_serde_tags_round_trip() {
        // Workflow with a default (absent) input map.
        let wf: JobTarget =
            serde_json::from_value(serde_json::json!({"type":"workflow","workflow_id":"w1"}))
                .unwrap();
        assert_eq!(
            wf,
            JobTarget::Workflow {
                workflow_id: "w1".into(),
                input: std::collections::HashMap::new(),
            }
        );
        // Agent, monitor, quest, and the two unit variants.
        assert_eq!(
            serde_json::from_value::<JobTarget>(
                serde_json::json!({"type":"agent","agent_id":"a","prompt":"p"})
            )
            .unwrap(),
            JobTarget::Agent {
                agent_id: "a".into(),
                prompt: "p".into(),
                model: None,
                conversation_id: None,
            }
        );
        assert_eq!(
            serde_json::from_value::<JobTarget>(serde_json::json!({"type":"identity_health"}))
                .unwrap(),
            JobTarget::IdentityHealth
        );
        assert_eq!(
            serde_json::from_value::<JobTarget>(serde_json::json!({"type":"learning_cycle"}))
                .unwrap(),
            JobTarget::LearningCycle
        );
        assert_eq!(
            serde_json::from_value::<JobTarget>(serde_json::json!({"type":"quest","quest_id":"q"}))
                .unwrap(),
            JobTarget::Quest {
                quest_id: "q".into()
            }
        );
        // App jobs, with and without a payload; an absent payload is not emitted.
        for (wire, payload) in [
            (
                serde_json::json!({"type":"app_job","plugin_id":"@x/app","job_id":"j1"}),
                None,
            ),
            (
                serde_json::json!({"type":"app_job","plugin_id":"@x/app","job_id":"j1",
                                   "payload":{"k":1}}),
                Some(serde_json::json!({"k":1})),
            ),
        ] {
            let target: JobTarget = serde_json::from_value(wire.clone()).unwrap();
            assert_eq!(
                target,
                JobTarget::AppJob {
                    plugin_id: "@x/app".into(),
                    job_id: "j1".into(),
                    payload,
                }
            );
            assert_eq!(serde_json::to_value(&target).unwrap(), wire);
        }
    }

    #[test]
    fn scheduled_job_serde_defaults_enabled_true_and_empty_history() {
        // A minimal job doc (pre-dating enabled/require_approval/history) must
        // deserialize with enabled=true, require_approval=false, empty history.
        let raw = serde_json::json!({
            "id": "old",
            "name": "legacy",
            "schedule": {"kind":"every","interval":"5m"},
            "target": {"type":"monitor","monitor_id":"m1"},
            "created_at": "2026-01-01T00:00:00Z",
            "updated_at": "2026-01-01T00:00:00Z"
        });
        let j: ScheduledJob = serde_json::from_value(raw).unwrap();
        assert!(j.enabled, "enabled must default to true");
        assert!(!j.require_approval);
        assert!(j.history.is_empty());
        assert!(matches!(j.schedule, Schedule::Every { .. }));
        // The retired per-app target loads as the generic app job.
        assert!(matches!(
            &j.target,
            JobTarget::AppJob { job_id, payload: None, .. } if job_id == "m1"
        ));
    }

    // ── Persisted-target normalizer ─────────────────────────────────────────

    fn legacy_job(
        id: &str,
        target: serde_json::Value,
        created_at: &str,
        runs: usize,
    ) -> serde_json::Value {
        let history: Vec<_> = (0..runs)
            .map(|n| {
                serde_json::json!({
                    "started_at": format!("2026-01-0{}T00:00:00Z", n + 1),
                    "finished_at": format!("2026-01-0{}T00:00:01Z", n + 1),
                    "outcome": "success",
                })
            })
            .collect();
        serde_json::json!({
            "id": id,
            "name": format!("legacy {id}"),
            "schedule": {"kind": "every", "interval": "5m"},
            "target": target,
            "enabled": false,
            "require_approval": true,
            "created_at": created_at,
            "updated_at": created_at,
            "last_run_at": "2026-01-03T00:00:01Z",
            "last_outcome": "success",
            "history": history,
        })
    }

    fn write_raw(directory: &std::path::Path, id: &str, value: &serde_json::Value) {
        std::fs::write(
            directory.join(format!("{id}.json")),
            serde_json::to_vec_pretty(value).unwrap(),
        )
        .unwrap();
    }

    #[test]
    fn normalize_rewrites_legacy_monitor_jobs_in_place_and_is_idempotent() {
        // The app the shim maps the retired target onto (named only in the shim).
        let JobTarget::AppJob {
            plugin_id: legacy_app,
            ..
        } = serde_json::from_value(serde_json::json!({"type": "monitor", "monitor_id": "x"}))
            .unwrap()
        else {
            panic!("the retired target maps onto an app job");
        };
        let legacy_app = legacy_app.as_str();
        let dir = tempfile::tempdir().unwrap();
        let directory = dir.path();
        let monitor = serde_json::json!({"type": "monitor", "monitor_id": "m1"});
        write_raw(
            directory,
            "monitor-m1",
            &legacy_job("monitor-m1", monitor.clone(), "2026-01-01T00:00:00Z", 3),
        );
        std::fs::create_dir_all(directory.join(".job-locks")).unwrap();
        let generation = uuid::Uuid::new_v4().to_string();
        std::fs::write(
            directory.join(".job-locks/monitor-m1.generation"),
            &generation,
        )
        .unwrap();
        // An OLDER user-made duplicate of the same target, with a foreign owner.
        let mut duplicate = legacy_job("job_0123abcd", monitor, "2025-01-01T00:00:00Z", 1);
        duplicate["owner_app"] = serde_json::json!("@x/other");
        write_raw(directory, "job_0123abcd", &duplicate);
        // A legacy monitor job with no canonical twin, owned by someone else.
        let mut lone = legacy_job(
            "job_lone",
            serde_json::json!({"type": "monitor", "monitor_id": "m2"}),
            "2025-02-01T00:00:00Z",
            0,
        );
        lone["owner_app"] = serde_json::json!("@x/other");
        write_raw(directory, "job_lone", &lone);
        // A tombstoned legacy job whose unlink did not happen.
        write_raw(
            directory,
            "monitor-m3",
            &legacy_job(
                "monitor-m3",
                serde_json::json!({"type": "monitor", "monitor_id": "m3"}),
                "2026-01-01T00:00:00Z",
                1,
            ),
        );
        std::fs::write(deleted_path(directory, "monitor-m3"), b"deleted").unwrap();
        // A legacy quest job stays exactly as it is.
        let quest = legacy_job(
            "quest-q1",
            serde_json::json!({"type": "quest", "quest_id": "q1"}),
            "2026-01-01T00:00:00Z",
            2,
        );
        write_raw(directory, "quest-q1", &quest);
        let quest_bytes = std::fs::read(directory.join("quest-q1.json")).unwrap();

        // monitor-m1 + job_lone rewritten, job_0123abcd rewritten then deleted,
        // and the tombstoned monitor-m3's leftover file removed.
        assert_eq!(normalize_persisted_targets_at(directory).unwrap(), 5);
        assert!(
            !directory.join("monitor-m3.json").exists(),
            "a tombstoned job's leftover file is removed"
        );

        let migrated = load_job_at(directory, "monitor-m1").unwrap();
        assert_eq!(
            migrated.target,
            JobTarget::AppJob {
                plugin_id: legacy_app.into(),
                job_id: "m1".into(),
                payload: None
            }
        );
        assert_eq!(migrated.owner_app.as_deref(), Some(legacy_app));
        assert_eq!(migrated.name, "legacy monitor-m1");
        assert_eq!(
            migrated.schedule,
            Schedule::Every {
                interval: "5m".into()
            }
        );
        assert!(!migrated.enabled);
        assert!(migrated.require_approval);
        assert_eq!(migrated.created_at, "2026-01-01T00:00:00Z");
        assert_eq!(
            migrated.last_run_at.as_deref(),
            Some("2026-01-03T00:00:01Z")
        );
        assert_eq!(migrated.last_outcome, Some(ExecOutcome::Success));
        assert_eq!(migrated.history.len(), 3);
        assert_eq!(
            std::fs::read_to_string(directory.join(".job-locks/monitor-m1.generation")).unwrap(),
            generation
        );
        let raw: serde_json::Value = serde_json::from_slice(
            &read_job_json(&directory.join("monitor-m1.json"), "monitor-m1").unwrap(),
        )
        .unwrap();
        assert_eq!(raw["target"]["type"], "app_job");

        assert!(
            !directory.join("job_0123abcd.json").exists(),
            "the duplicate is deleted"
        );
        let lone = load_job_at(directory, "job_lone").unwrap();
        assert_eq!(
            lone.owner_app.as_deref(),
            Some(legacy_app),
            "a request-supplied owner is overwritten"
        );
        assert!(
            load_job_at(directory, "monitor-m3").is_err(),
            "a tombstone is not resurrected"
        );
        // A non-app job keeps its content: it is only sealed (same JSON).
        let quest_stored = std::fs::read(directory.join("quest-q1.json")).unwrap();
        assert!(ryu_durable::SealingCodec::is_sealed(&quest_stored));
        assert_eq!(
            decode_record(KIND_JOB, "quest-q1", &quest_stored).unwrap(),
            quest_bytes
        );

        // Idempotent: nothing is written or deleted the second time.
        let snapshot: Vec<(String, Vec<u8>)> = ["monitor-m1", "job_lone", "quest-q1"]
            .iter()
            .map(|id| {
                (
                    (*id).to_owned(),
                    std::fs::read(directory.join(format!("{id}.json"))).unwrap(),
                )
            })
            .collect();
        assert_eq!(normalize_persisted_targets_at(directory).unwrap(), 0);
        for (id, bytes) in snapshot {
            assert_eq!(
                std::fs::read(directory.join(format!("{id}.json"))).unwrap(),
                bytes,
                "{id}"
            );
        }
        assert!(normalize_persisted_targets_at(&directory.join("absent")).unwrap() == 0);
    }

    #[test]
    fn normalize_finishes_an_interrupted_delete_of_a_legacy_plaintext_job() {
        let dir = tempfile::tempdir().unwrap();
        let directory = dir.path();
        // A legacy plaintext agent job whose delete committed the tombstone but
        // never unlinked the file (refused unlink or crash).
        let job = legacy_job(
            "quest-gone",
            serde_json::json!({"type": "quest", "quest_id": "q9"}),
            "2026-01-01T00:00:00Z",
            2,
        );
        write_raw(directory, "quest-gone", &job);
        std::fs::create_dir_all(directory.join(".job-locks")).unwrap();
        std::fs::write(deleted_path(directory, "quest-gone"), b"deleted").unwrap();

        assert_eq!(normalize_persisted_targets_at(directory).unwrap(), 1);
        assert!(
            !directory.join("quest-gone.json").exists(),
            "the deleted job's plaintext file is removed, not sealed or kept"
        );
        assert!(deleted_path(directory, "quest-gone").exists());
        assert!(load_job_at(directory, "quest-gone").is_err());

        // A second pass changes nothing.
        assert_eq!(normalize_persisted_targets_at(directory).unwrap(), 0);
        assert!(!directory.join("quest-gone.json").exists());
    }

    #[test]
    fn cron_tz_and_agent_model_are_optional_on_the_wire() {
        // Absent: every job written before these fields existed still loads,
        // and keeps its old meaning (UTC, agent's configured model).
        let bare: Schedule =
            serde_json::from_value(serde_json::json!({"kind":"cron","expr":"0 5 * * *"})).unwrap();
        assert_eq!(
            bare,
            Schedule::Cron {
                expr: "0 5 * * *".into(),
                tz: None
            }
        );
        let bare_agent: JobTarget = serde_json::from_value(
            serde_json::json!({"type":"agent","agent_id":"a","prompt":"hi"}),
        )
        .unwrap();
        assert!(matches!(bare_agent, JobTarget::Agent { model: None, .. }));

        // Present: both round-trip, and neither is emitted when empty (so a
        // UTC job's file is byte-identical to what it was before).
        let zoned = Schedule::Cron {
            expr: "0 5 * * *".into(),
            tz: Some("Europe/Lisbon".into()),
        };
        let json = serde_json::to_string(&zoned).unwrap();
        assert!(json.contains("Europe/Lisbon"));
        assert_eq!(serde_json::from_str::<Schedule>(&json).unwrap(), zoned);
        assert!(!serde_json::to_string(&bare).unwrap().contains("tz"));
    }

    #[test]
    fn owner_app_defaults_absent_and_round_trips() {
        let mut j = job();
        assert!(j.owner_app.is_none());
        assert!(!serde_json::to_string(&j).unwrap().contains("owner_app"));
        j.owner_app = Some("@ryu/warmup".into());
        let round: ScheduledJob =
            serde_json::from_str(&serde_json::to_string(&j).unwrap()).unwrap();
        assert_eq!(round.owner_app.as_deref(), Some("@ryu/warmup"));
    }

    #[test]
    fn exec_outcome_serializes_snake_case() {
        assert_eq!(
            serde_json::to_string(&ExecOutcome::Success).unwrap(),
            "\"success\""
        );
        assert_eq!(
            serde_json::to_string(&ExecOutcome::Failure).unwrap(),
            "\"failure\""
        );
    }

    #[test]
    fn job_files_are_sealed_and_legacy_plaintext_is_resealed_on_write() {
        let dir = tempfile::tempdir().unwrap();
        let directory = dir.path();
        let marker = format!("promptmarker{}", uuid::Uuid::new_v4().simple());
        let mut sealed_job = job();
        sealed_job.id = "job_sealed".into();
        sealed_job.target = JobTarget::Agent {
            agent_id: "watch".into(),
            prompt: format!("Summarize {marker}"),
            model: None,
            conversation_id: None,
        };
        write_job_file(directory, "job_sealed", &sealed_job).unwrap();
        let raw = std::fs::read_to_string(directory.join("job_sealed.json")).unwrap();
        assert!(raw.starts_with("encb:v1:"));
        assert!(!raw.contains(&marker));
        assert_eq!(
            load_job_at(directory, "job_sealed").unwrap().target,
            sealed_job.target
        );
        assert_eq!(list_jobs_at(directory).len(), 1);

        // Moved to another id: does not open, and the listing skips it.
        std::fs::copy(
            directory.join("job_sealed.json"),
            directory.join("job_moved.json"),
        )
        .unwrap();
        assert!(load_job_at(directory, "job_moved").is_err());
        assert_eq!(list_jobs_at(directory).len(), 1);
        std::fs::remove_file(directory.join("job_moved.json")).unwrap();

        // Legacy plaintext reads, and the next write seals it.
        let mut legacy = sealed_job.clone();
        legacy.id = "job_legacy".into();
        std::fs::write(
            directory.join("job_legacy.json"),
            serde_json::to_vec_pretty(&legacy).unwrap(),
        )
        .unwrap();
        assert_eq!(
            load_job_at(directory, "job_legacy").unwrap().target,
            legacy.target
        );
        append_execution_at(
            &directory.join("job_legacy.json"),
            record(ExecOutcome::Success, "2026-09-11T00:00:00Z"),
        )
        .unwrap();
        let resealed = std::fs::read_to_string(directory.join("job_legacy.json")).unwrap();
        assert!(resealed.starts_with("encb:v1:"));
        assert!(!resealed.contains(&marker));
        assert_eq!(read_job_for_test(directory, "job_legacy").history.len(), 1);
    }

    #[test]
    fn start_up_pass_seals_legacy_job_files_and_pointers_once() {
        let dir = tempfile::tempdir().unwrap();
        let directory = dir.path();
        let marker = format!("promptmarker{}", uuid::Uuid::new_v4().simple());
        let mut legacy = job();
        legacy.id = "job_paused".into();
        legacy.enabled = false;
        legacy.target = JobTarget::Agent {
            agent_id: "watch".into(),
            prompt: format!("Summarize {marker}"),
            model: None,
            conversation_id: None,
        };
        legacy.record_execution(ExecRecord {
            error: Some(format!("failed on {marker}")),
            ..record(ExecOutcome::Failure, "2026-09-11T00:00:00Z")
        });
        let legacy_json = serde_json::to_vec_pretty(&legacy).unwrap();
        std::fs::write(directory.join("job_paused.json"), &legacy_json).unwrap();
        let slots = directory.join(".quick-routines");
        std::fs::create_dir_all(&slots).unwrap();
        let pointer = slots.join("abc123.json");
        std::fs::write(
            &pointer,
            serde_json::to_vec(&serde_json::json!({
                "agent_id": "watch",
                "owner_user_id": format!("owner{marker}"),
                "org_id": null,
                "id": "job_paused",
                "acknowledged": true,
                "generation": 1,
            }))
            .unwrap(),
        )
        .unwrap();
        // Crash leftovers of earlier writes (old enough to be orphans).
        let old = std::time::SystemTime::now() - std::time::Duration::from_secs(600);
        for orphan in [directory.join(".tmpAb12Cd"), slots.join(".tmpEf34Gh")] {
            std::fs::write(&orphan, &legacy_json).unwrap();
            std::fs::File::options()
                .write(true)
                .open(&orphan)
                .unwrap()
                .set_modified(old)
                .unwrap();
        }

        // Nothing is "normalized" (no app jobs), but everything is sealed.
        assert_eq!(normalize_persisted_targets_at(directory).unwrap(), 0);
        let raw = std::fs::read_to_string(directory.join("job_paused.json")).unwrap();
        assert!(raw.starts_with("encb:v1:"));
        assert!(!raw.contains(&marker));
        let opened = read_job_for_test(directory, "job_paused");
        assert_eq!(opened.target, legacy.target);
        assert!(!opened.enabled);
        assert_eq!(opened.history.len(), 1);
        let raw_pointer = std::fs::read_to_string(&pointer).unwrap();
        assert!(raw_pointer.starts_with("encb:v1:"));
        assert!(!raw_pointer.contains(&marker));
        assert_eq!(
            read_quick_routine_pointer_for_test(&pointer)["id"],
            "job_paused"
        );
        assert!(!directory.join(".tmpAb12Cd").exists());
        assert!(!slots.join(".tmpEf34Gh").exists());

        // Run twice: nothing is rewritten.
        let sealed_job = std::fs::read(directory.join("job_paused.json")).unwrap();
        let sealed_pointer = std::fs::read(&pointer).unwrap();
        assert_eq!(normalize_persisted_targets_at(directory).unwrap(), 0);
        assert_eq!(
            std::fs::read(directory.join("job_paused.json")).unwrap(),
            sealed_job
        );
        assert_eq!(std::fs::read(&pointer).unwrap(), sealed_pointer);
    }

    #[test]
    fn quick_routine_pointers_are_sealed() {
        let dir = tempfile::tempdir().unwrap();
        let pointer = dir.path().join("abc123.json");
        let slot = QuickRoutineSlot {
            agent_id: "agent-marker".into(),
            owner_user_id: Some("owner-marker".into()),
            org_id: None,
            id: "job_x".into(),
            acknowledged: true,
            generation: 2,
        };
        write_slot(&pointer, "abc123", &slot).unwrap();
        let raw = std::fs::read_to_string(&pointer).unwrap();
        assert!(raw.starts_with("encb:v1:"));
        assert!(!raw.contains("owner-marker"));
        let opened = read_quick_routine_pointer_for_test(&pointer);
        assert_eq!(opened["owner_user_id"], "owner-marker");
        assert_eq!(opened["generation"], 2);
    }
}
