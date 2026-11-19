//! Metering a session Box run, and parking it for billing.
// test-exempt: moved verbatim out of server/session_box.rs; covered by session_box/tests.rs and broker_relay_tests.rs.

use super::*;

// ── Metering ─────────────────────────────────────────────────────────────────

/// Register heartbeat metering for a Box run unless another owner bills it.
///
/// - `settlement` and `subscription` credentials are never metered by Core
///   (one billing owner per tenant, design §8.3).
/// - The run ticks [`ryu_sandbox::box_types::spec_for`] of the Box's own size,
///   sends `size` and `box_id`, and parks (never destroys) on a kill verdict.
/// - A `core_tick` tenant renews the Box service's liveness lease after every
///   accepted tick.
/// - `minimum_waiver` is the Box service's signed verdict for this start
///   (`PublicBox.billing.waiver`): a resume onto the Box's own parked VM
///   inside the provider hour already paid for. The run's ticks forward it,
///   and the Gateway verifies it before charging no new five-minute minimum.
pub(crate) async fn start_metering(
    run_id: &str,
    box_id: &WorkspaceId,
    size: BoxSize,
    billing_owner: BillingOwner,
    on_kill: ParkFn,
    minimum_waiver: Option<String>,
) -> Option<BoxMetering> {
    if matches!(
        billing_owner,
        BillingOwner::Settlement | BillingOwner::Subscription
    ) || ryu_sandbox::box_backend::subscription_passthrough_active().await
    {
        return None;
    }
    let org_id = crate::sidecar::control_plane::registered_org().map(|org| org.id);
    let spec = ryu_sandbox::box_types::spec_for(size);
    let budget_micro_usd = heartbeat::default_run_budget_micro_usd().await;
    heartbeat::register_run(
        run_id.to_owned(),
        org_id.clone(),
        "box",
        box_id.clone(),
        spec.clone(),
        budget_micro_usd,
        RunOptions {
            kill_action: KillAction::Park(on_kill),
            size: Some(size),
            box_id: Some(box_id.0.clone()),
            minimum_waiver,
        },
    );
    if billing_owner == BillingOwner::CoreTick {
        let box_id = box_id.clone();
        heartbeat::on_tick_accepted(
            run_id.to_owned(),
            Arc::new(move |tick: heartbeat::TickAccepted| {
                let box_id = box_id.clone();
                Box::pin(async move {
                    let sent = match box_client().await {
                        Ok(client) => client
                            .keepalive(&box_id, tick.tick_index, tick.accrued_micro_usd)
                            .await
                            .map_err(|error| error.to_string()),
                        Err(error) => Err(error.to_string()),
                    };
                    if let Err(error) = sent {
                        tracing::warn!(error = %error, "Box keepalive failed; the liveness lease may park the Box");
                    }
                })
            }),
        );
    }
    Some(BoxMetering {
        org_id,
        spec,
        budget_micro_usd,
        started: Instant::now(),
    })
}

/// Deregister a run and debit its un-ticked tail, as `session::destroy_sandbox`
/// does. A run the heartbeat already removed (a kill) has nothing left.
pub(crate) async fn finish_metering(run_id: &str, metering: Option<&BoxMetering>) {
    let Some(metering) = metering else {
        return;
    };
    let Some(residual) = heartbeat::deregister_for_final_debit(run_id) else {
        return;
    };
    let Some(org_id) = metering.org_id.clone() else {
        return;
    };
    let measured = metering.started.elapsed().as_secs().max(1);
    if let Err(error) = heartbeat::debit_final(
        run_id.to_owned(),
        Some(org_id),
        metering.spec.clone(),
        measured.saturating_sub(residual.ticked_seconds),
        metering.budget_micro_usd,
        residual,
    )
    .await
    {
        tracing::warn!(error = %error, "Session Box final billing could not be confirmed");
    }
}

/// Delays between park attempts after a billing park interrupted a busy Box.
pub(super) const BUSY_PARK_RETRIES: [Duration; 4] = [
    Duration::from_millis(250),
    Duration::from_millis(500),
    Duration::from_secs(1),
    Duration::from_secs(2),
];

pub(super) fn is_box_busy(error: &BoxApiError) -> bool {
    matches!(error, BoxApiError::Http { status: 409, code, .. } if code == "box_busy")
}

/// Park a Box for a billing verdict (balance, budget or accounting). The Box
/// service refuses a stop with `409 box_busy` while a foreground command
/// holds the Box; a Box that is out of credit must not keep running until
/// that command ends, so its processes are interrupted (as the service's own
/// sweeps do) and the park retried. A Box that is already gone counts as
/// parked.
pub(crate) async fn park_for_billing(
    client: &BoxSessionClient,
    box_id: &WorkspaceId,
    reason: ParkReason,
) -> Result<(), BoxApiError> {
    let error = match client.park(box_id, reason).await {
        Ok(()) | Err(BoxApiError::NotFound) => return Ok(()),
        Err(error) if is_box_busy(&error) => error,
        Err(error) => return Err(error),
    };
    if let Err(interrupt) = client.interrupt(box_id).await {
        tracing::warn!(error = %interrupt, "Busy Box could not be interrupted for a billing park");
        return Err(error);
    }
    let mut last = error;
    for delay in BUSY_PARK_RETRIES {
        tokio::time::sleep(delay).await;
        match client.park(box_id, reason).await {
            Ok(()) | Err(BoxApiError::NotFound) => return Ok(()),
            Err(error) if is_box_busy(&error) => last = error,
            Err(error) => return Err(error),
        }
    }
    Err(last)
}

/// The kill action of one live phase of a session Box: park with the
/// verdict's reason, then record the stop so the UI shows it.
pub(super) fn session_kill_action(
    key: SessionBoxKey,
    box_id: WorkspaceId,
    lease_epoch: u64,
) -> ParkFn {
    Arc::new(move |reason: KillReason| {
        let key = key.clone();
        let box_id = box_id.clone();
        Box::pin(async move {
            let client = box_client().await?;
            park_for_billing(&client, &box_id, reason.park_reason())
                .await
                .map_err(anyhow::Error::new)?;
            tokio::spawn(mark_killed(key, lease_epoch, reason));
            Ok(())
        })
    })
}

/// After a kill verdict parked the Box: the heartbeat already removed the run,
/// so only the registry and the lease change. Only the live phase the verdict
/// was for is marked; a Box resumed since then is a new phase.
pub(super) async fn mark_killed(key: SessionBoxKey, lease_epoch: u64, reason: KillReason) {
    let Some(slot) = existing_slot(&key) else {
        return;
    };
    let mut guard = slot.lock().await;
    let Some(entry) = guard.as_mut() else {
        return;
    };
    if entry.phase != Phase::Live || entry.lease_epoch != lease_epoch {
        return;
    }
    entry.stop_refresher();
    entry.metering = None;
    entry.phase = Phase::Parked;
    entry.stop_reason = Some(reason.as_str().to_owned());
    if let Err(error) = write_lease(&lease_of(entry)) {
        tracing::warn!(error = %error, "Session Box lease could not record the park");
    }
}
