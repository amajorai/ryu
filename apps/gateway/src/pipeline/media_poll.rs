use super::*;

/// Poll a previously-submitted video job by id. See [`poll_media_job`].
pub async fn poll_video_job(
    state: Arc<AppState>,
    ctx: RequestContext,
    job_id: String,
) -> Result<Value, GatewayError> {
    poll_media_job(state, ctx, job_id, Modality::Video).await
}

/// Poll a previously-submitted audio-generation job by id. See
/// [`poll_media_job`].
pub async fn poll_audio_job(
    state: Arc<AppState>,
    ctx: RequestContext,
    job_id: String,
) -> Result<Value, GatewayError> {
    poll_media_job(state, ctx, job_id, Modality::Audio).await
}

/// Poll a previously-submitted media job by id. Tenant-isolated: the polling API
/// key must match the key that submitted the job, and the job must belong to the
/// polled modality. Terminal jobs return their cached result; otherwise the
/// provider is re-polled and the store updated. On the transition to
/// `succeeded` the job is debited once (idempotent via the `{id}:{modality}`
/// ref).
pub async fn poll_media_job(
    state: Arc<AppState>,
    ctx: RequestContext,
    job_id: String,
    modality: Modality,
) -> Result<Value, GatewayError> {
    let label = modality.as_str();
    let Some(job) = state
        .jobs
        .get(&job_id)
        .filter(|job| job.modality == modality)
    else {
        return Err(GatewayError::BadRequest(format!(
            "no such {label} job: {job_id}"
        )));
    };
    // Tenant isolation: the redacted org label is shared by all dynamic
    // credentials in an organization, so require both the independent tenant
    // binding and the stable per-bearer owner binding. Return the same not-found
    // shape as an unknown id so ownership cannot be probed.
    if !job.belongs_to(ctx.org_id.as_deref(), &ctx.api_key, &ctx.owner_binding) {
        return Err(GatewayError::BadRequest(format!(
            "no such {label} job: {job_id}"
        )));
    }
    state.jobs.touch(&job_id);
    if job.status.is_terminal() {
        return Ok(job.to_response());
    }

    let Some(origin) = job.origin.as_ref() else {
        return Err(GatewayError::AllProvidersUnavailable(format!(
            "{label} job origin '{}' is unavailable",
            job.provider.as_str()
        )));
    };

    let poll = match origin.poll().await {
        Ok(poll) => poll,
        Err(blocked) => {
            state.jobs.record_poll_blocked(&job_id, blocked);
            return Ok(state.jobs.get(&job_id).unwrap_or(job).to_response());
        }
    };
    let transition = state.jobs.apply_poll(
        &job_id,
        poll.status,
        poll.output.clone(),
        poll.error.clone(),
    );
    let newly_succeeded = transition.became_succeeded;

    let poll_has_output = poll
        .output
        .as_ref()
        .and_then(|o| o["data"].as_array())
        .is_some_and(|a| !a.is_empty());
    if newly_succeeded && poll_has_output {
        if let Some(org_id) = job.org_id.clone().filter(|s| !s.is_empty()) {
            // Same fix as the submit path: price from the compute time the
            // provider REPORTED, with the flat rate as a marked fallback. The
            // poll's own output is the provider payload `to_response()` flattens,
            // so `usage.compute_seconds` lives there when it is reported at all.
            // A job with no output resolves to `Null`, which simply misses the
            // lookup and falls back — the same as any provider that reports none.
            let poll_payload = poll.output.clone().unwrap_or(serde_json::Value::Null);
            let (cost, estimated) = state
                .config
                .credits
                .media_cost_from_response(&job.modality, &poll_payload);
            record_charged_budget_for_ids(
                &state,
                &job.owner_binding,
                job.org_id.as_deref(),
                job.user_id.as_deref(),
                job.agent_id.as_deref(),
                job.session_id.as_deref(),
                BudgetChargeKind::Media,
                state
                    .config
                    .credits
                    .debit_amount_for_provider(Some(job.provider.as_str()), cost),
                job.org_limit_subject.as_ref(),
            );
            // Outside the `cost > 0` guard — see the sync media path above.
            if estimated {
                warn!(
                    cost,
                    billed = cost > 0,
                    modality = label,
                    "credits: media job billed at the FLAT fallback rate — \
                     the provider reported no compute time"
                );
            }
            if cost > 0 {
                let fail_closed_sticky = state.config.credits.fail_closed && ctx.managed_inference;
                let credit_reservation = state.jobs.take_reservation(&job_id);
                let provider_name = job.provider.as_str().to_owned();
                let pool = crate::credit_pools::pool_for_gateway_provider(job.provider.as_str());
                let model = job.model.clone();
                let duration_ms = poll_payload["usage"]["compute_seconds"]
                    .as_f64()
                    .filter(|seconds| *seconds > 0.0)
                    .map(|seconds| (seconds * 1000.0).round() as u64);
                let user_id = job.user_id.clone();
                // The job's own tags: a poll arrives on a later request.
                let tags = job
                    .org_limit_subject
                    .as_ref()
                    .map(|subject| subject.tags.clone())
                    .unwrap_or_default();
                let task_label = media_task_label(&job.modality, estimated);
                let debit_ref = format!("{job_id}:{}", job.modality.as_str());
                let state_debit = state.clone();
                tokio::spawn(async move {
                    debit_wallet_for_request(
                        state_debit,
                        org_id,
                        debit_ref,
                        CreditDebitReason::GatewayUsage,
                        cost,
                        fail_closed_sticky,
                        None,
                        pool,
                        DebitAttribution {
                            provider: Some(provider_name),
                            // The JOB's own model, not a request decision: a poll
                            // arrives on a later request that never made one.
                            model: Some(model),
                            // Present exactly when the provider reported compute
                            // time; absent means this row was priced at the flat
                            // fallback rate. (poll)
                            duration_ms,
                            user_id,
                            task_label: Some(task_label),
                            tags,
                            ..Default::default()
                        },
                    )
                    .await;
                    drop(credit_reservation);
                });
            }
        }
    }

    // A failed/cancelled terminal result, a successful job with no output, or a
    // zero-cost/non-managed success has no debit task to own the claim. A paid
    // success already moved it into the debit task above.
    if transition.became_terminal {
        drop(state.jobs.take_reservation(&job_id));
    }

    let updated = state.jobs.get(&job_id).unwrap_or(job);
    Ok(updated.to_response())
}

// ─── Unified tool loop signal (#475) ───────────────────────────────────────────
