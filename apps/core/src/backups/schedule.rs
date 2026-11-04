//! Scheduled node backups and the retention candidates they may prune.

use super::*;

pub(super) fn retained_candidates(
    records: Vec<BackupRecord>,
    source_node_id: &str,
) -> Vec<BackupRecord> {
    records
        .into_iter()
        .filter(|record| !source_node_id.is_empty() && record.source_node_id == source_node_id)
        .collect()
}

/// Node policies run with the operator-authorized node scope, not a stored user
/// JWT. Disabling/removing the policy prevents future runs; minute claims persist
/// before work is queued so a restart cannot replay the same cron tick.
pub fn start_scheduler(state: ServerState) {
    static STARTED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    if STARTED.swap(true, std::sync::atomic::Ordering::SeqCst) {
        return;
    }
    tokio::spawn(async move {
        let mut interval = tokio::time::interval(std::time::Duration::from_secs(30));
        loop {
            interval.tick().await;
            let Ok(service) = global().await else {
                tracing::error!("Backup settings could not be loaded");
                continue;
            };
            let time = Utc::now()
                .with_second(0)
                .and_then(|v| v.with_nanosecond(0))
                .expect("valid minute");
            let minute = time.to_rfc3339();
            let due = service
                .update(|store| {
                    let mut due = Vec::new();
                    for policy in &mut store.policies {
                        if policy.enabled
                            && policy.last_attempt_at.as_deref() != Some(&minute)
                            && CronSchedule::parse(&policy.schedule)
                                .is_ok_and(|cron| cron.matches(time))
                        {
                            policy.last_attempt_at = Some(minute.clone());
                            due.push(policy.clone());
                        }
                    }
                    Ok(due)
                })
                .await;
            let Ok(due) = due else {
                tracing::error!("Could not persist backup schedule tick");
                continue;
            };
            for policy in due {
                let key = format!("schedule:{}:{}", policy.id, time.timestamp());
                if service
                    .create(
                        state.clone(),
                        CreateBackup {
                            destination_id: policy.destination_id,
                            scope: policy.scope,
                            idempotency_key: key,
                        },
                        None,
                    )
                    .await
                    .is_err()
                {
                    tracing::warn!(policy_id = %policy.id, "Scheduled backup could not be queued");
                }
            }
        }
    });
}
