//! One-off setup checks in their own disposable Box.
//! test-exempt: needs a live Box service; the network-secret create it now calls is covered by ryu-sandbox's `network_secrets_test.rs` and the refusal mapping by `cloud_box_network_secret_refusal_is_said_plainly_without_values`.

use super::teardown::destroy_named;
use super::*;

/// A one-off setup check in its own disposable Box (`launch`).
pub(in crate::server::cloud_tasks) async fn setup_check(
    script: &str,
    env: &[(String, String)],
    network: BoxNetworkPlan,
) -> Result<ExecOutput> {
    let client = session_box::box_client().await?;
    let name = format!("ryu-setup-{}", uuid::Uuid::new_v4().simple());
    let size = BoxSize::Small;
    let spec = DisposableBoxSpec {
        name: name.clone(),
        image: None,
        network: network.network.clone(),
        ttl_seconds: SETUP_CHECK_TTL_SECONDS,
        setup: vec![ENSURE_GIT_SCRIPT.to_owned()],
        size,
        desktop: false,
        labels: BTreeMap::new(),
    };
    let created = client
        .create_disposable_with_network_secrets(&spec, &name, &network.secrets)
        .await;
    let workspace = match created {
        Ok(workspace) => workspace,
        Err(error) => {
            let _ = destroy_named(&client, &name).await;
            return Err(network_secrets_refusal(error, &network));
        }
    };
    let metering = register_setup_metering(&name, &workspace, size, &client).await;
    let result = client
        .exec_script(&workspace, script, env, BoxUser::Box, 120)
        .await;
    let billing = finalize_setup_metering(&name, metering).await;
    if let Err(error) = client.destroy(&workspace).await {
        // Retry by name before giving up; the check's short TTL reaps a Box
        // both attempts miss, and the check's own result still stands.
        if destroy_named(&client, &name).await.is_err() {
            tracing::warn!(error = %error, "Box setup check could not be destroyed; its TTL removes it");
        }
    }
    if let Err(error) = billing {
        tracing::warn!(error = %error, "Box setup check destroyed; final billing could not be confirmed");
    }
    result
}

/// A setup check is disposable: it is metered at its size and destroyed (not
/// parked) on a kill verdict.
pub(super) async fn register_setup_metering(
    run_id: &str,
    workspace: &WorkspaceId,
    size: BoxSize,
    client: &BoxSessionClient,
) -> Option<(Option<String>, ryu_sandbox::spec::SandboxSpec, u64, Instant)> {
    use ryu_sandbox::box_credential::BillingOwner;
    if matches!(
        client.billing_owner(),
        BillingOwner::Settlement | BillingOwner::Subscription
    ) || ryu_sandbox::box_backend::subscription_passthrough_active().await
    {
        return None;
    }
    let org_id = crate::sidecar::control_plane::registered_org().map(|org| org.id);
    let spec = ryu_sandbox::box_types::spec_for(size);
    let budget = heartbeat::default_run_budget_micro_usd().await;
    heartbeat::register_run(
        run_id.to_owned(),
        org_id.clone(),
        "box",
        workspace.clone(),
        spec.clone(),
        budget,
        RunOptions {
            kill_action: KillAction::Destroy,
            size: Some(size),
            box_id: Some(workspace.0.clone()),
            // A created Box always pays its per-start minimum.
            minimum_waiver: None,
        },
    );
    Some((org_id, spec, budget, Instant::now()))
}

pub(super) async fn finalize_setup_metering(
    run_id: &str,
    metering: Option<(Option<String>, ryu_sandbox::spec::SandboxSpec, u64, Instant)>,
) -> Result<(), String> {
    let Some((org_id, spec, budget, started)) = metering else {
        return Ok(());
    };
    let Some(residual) = heartbeat::deregister_for_final_debit(run_id) else {
        return Ok(());
    };
    let Some(org_id) = org_id else {
        return Ok(());
    };
    let measured = started.elapsed().as_secs().max(1);
    heartbeat::debit_final(
        run_id.to_owned(),
        Some(org_id),
        spec,
        measured.saturating_sub(residual.ticked_seconds),
        budget,
        residual,
    )
    .await
}
