//! Prepare paid pool legs through the same captured Gateway governance client.
use super::pool_execution::{ExecutionLimits, FusionOutcome, FusionPlan, PipelinePlan, PoolTarget};
use super::*;

pub(super) enum PreparedExecution {
    Final {
        target: PoolTarget,
        body: Value,
        timeout_ms: u64,
        output_bytes: usize,
    },
    Single {
        target: PoolTarget,
        response: Value,
    },
}

pub(super) async fn prepare(
    state: Arc<AppState>,
    ctx: &RequestContext,
    route: &crate::provider_pools::SelectedPoolRoute,
    body: Value,
) -> Result<Option<PreparedExecution>, GatewayError> {
    let Some(execution) = &route.execution else {
        return Ok(None);
    };
    for target in &execution.targets {
        auxiliary::authorize_model(&state, ctx, &target.model)?;
        let provider = canonical_sdk_provider(&state, ctx, &target.provider, &target.model)?;
        inference_governance::authorize_provider_region(&state, ctx, &provider)?;
    }
    if let Some(judge) = &execution.judge {
        auxiliary::authorize_model(&state, ctx, &judge.model)?;
        let provider = canonical_sdk_provider(&state, ctx, &judge.provider, &judge.model)?;
        inference_governance::authorize_provider_region(&state, ctx, &provider)?;
    }
    let client = Arc::new(auxiliary::GovernedInference::for_pool(
        state,
        ctx.clone(),
        route.pool_name.clone(),
    ));
    let targets = execution
        .targets
        .iter()
        .map(|target| PoolTarget {
            provider: target.provider.as_str().to_owned(),
            model: target.model.clone(),
        })
        .collect();
    let limits = ExecutionLimits {
        leg_timeout_ms: execution.limits.leg_timeout_ms,
        total_timeout_ms: execution.limits.total_timeout_ms,
        max_output_bytes: execution.limits.max_output_bytes,
    };
    match execution.strategy {
        crate::config::ProviderPoolStrategy::Fusion => {
            let judge = execution
                .judge
                .as_ref()
                .ok_or_else(|| GatewayError::BadRequest("Fusion judge missing".into()))?;
            let outcome = pool_execution::prepare_fusion(
                client,
                &FusionPlan {
                    panels: targets,
                    judge: PoolTarget {
                        provider: judge.provider.as_str().to_owned(),
                        model: judge.model.clone(),
                    },
                    quorum: execution.limits.quorum,
                    grace_ms: execution.limits.grace_ms,
                    limits,
                },
                body,
            )
            .await?;
            Ok(Some(match outcome {
                FusionOutcome::Single { target, response } => {
                    PreparedExecution::Single { target, response }
                }
                FusionOutcome::Judge {
                    target,
                    body,
                    remaining_timeout_ms,
                    remaining_output_bytes,
                } => PreparedExecution::Final {
                    target,
                    body,
                    timeout_ms: remaining_timeout_ms,
                    output_bytes: remaining_output_bytes,
                },
            }))
        }
        crate::config::ProviderPoolStrategy::Pipeline => {
            let outcome = pool_execution::prepare_pipeline(
                client,
                &PipelinePlan {
                    stages: targets,
                    limits,
                },
                body,
            )
            .await?;
            Ok(Some(PreparedExecution::Final {
                target: outcome.target,
                body: outcome.body,
                timeout_ms: outcome.remaining_timeout_ms,
                output_bytes: outcome.remaining_output_bytes,
            }))
        }
        _ => Err(GatewayError::BadRequest(
            "Invalid multi-leg pool strategy".into(),
        )),
    }
}
