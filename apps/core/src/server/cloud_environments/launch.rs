//! The disposable setup-check route.
//! test-exempt: the launch route moved here unchanged apart from passing the Box network plan; cloud_tasks/route_gate_tests.rs drives it through the router (`box_route_gate_launch_*`).

use super::box_secrets::BoxNetworkPlan;
use super::prepare::prepare_environment;
use super::script::{PreparedEnvironment, TaskBackend};
use super::*;

#[utoipa::path(post, path="/api/cloud-environments/{id}/launch", tag="Cloud environments", security(("bearerAuth"=[])), params(("id"=String,Path,description="Published personally owned environment ID")), description="Run a disposable setup check on the selected node. Requires GatewayRoute, ToolsExec, personal identity, explicit fail-closed Gateway execution-budget approval and explicit Gateway outbound grant approval. Disabled internet needs no outbound grant; unrestricted needs network:egress:unrestricted; restricted domains need tool:http-egress:host approval for every expanded host. Provider platform overlays do not substitute for Gateway approval. The configured OpenSandbox provider supports explicit all/package-manager/custom/disabled egress and HTTPS network-secret substitution; readiness requires status=ok, dns+nft packet enforcement, exact policy rules and acknowledged sanitized vault scope metadata before workload upload. Secrets travel to the authenticated sidecar vault over HTTPS or literal loopback HTTP; workload environment receives placeholders. GH_TOKEN or GITHUB_TOKEN scoped to github.com supplies Git clone authorization. Repositories use separate owner/repository directories; install scripts run in the first repository root or an empty workspace when no repository is selected. Without OpenSandbox, rootless Docker supports disabled or unrestricted internet with task-visible ordinary variables. Per-environment Tailscale VPN uses an explicitly configured isolated rootless Docker runtime with preloaded versioned workload, egress and Tailscale images. Gateway must additionally approve network:vpn:tailscale for trusted enrollment and relay traffic. The saved reusable auth key must be scoped to this environment and cannot also be a task variable, a network-secret binding, or appear in scripts/instructions. VPN helpers enroll with memory-only state and userspace networking; workload runs unprivileged behind exact packet-enforced egress with public CA delivery. Saving the key does not test connectivity; setup checks enroll and run. Expired credential-free resource leases are recovered at startup and periodically. Internet-disabled VPN fails closed. Scripts run with a 120-second execution timeout and cleanup follows completion/failure/disconnection. Output redacts saved values and is bounded to 65536 characters per stream. startInstructions are returned for the next task; no durable cloud task workspace is created. Each invocation is a new setup check; callers must not automatically retry.", responses((status=200,body=Value,description="completed or failed status with exitCode/stdout/stderr/startInstructions"),(status=403,description="Execution authority, Gateway network grants or budget denied; cloud_environment_feature_unavailable: a box environment for a signed-in account without the Fresh cloud box rollout"),(status=404,description="Owned published template missing"),(status=422,description="Policy unavailable, missing value, domains or scope mismatch"),(status=503,description="Provider, packet enforcement, vault or cleanup unavailable")))]
pub(super) async fn launch(
    State(_state): State<ServerState>,
    Extension(auth): Extension<ResolvedAuthorization>,
    Path(id): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let prepared = prepare_environment(&auth, &id).await?;
    let PreparedEnvironment {
        script,
        secrets,
        governed_spec,
        vpn_backend,
        vpn_key,
        governed,
        network,
        backend_label,
        start_instructions,
        backend,
        box_env,
        box_network,
        ..
    } = prepared;
    let audit_user_id = auth
        .caller
        .as_ref()
        .map(|caller| caller.user_id.clone())
        .or_else(|| match &auth.context.principal {
            crate::authorization::Principal::User { subject_id } => Some(subject_id.clone()),
            _ => None,
        });
    // The detached operation always removes its container after a timeout or a
    // disconnected HTTP client; a dropped docker-run client does not do that.
    let output = tokio::spawn(async move {
        let started = std::time::Instant::now();
        let result = async {
            if backend == TaskBackend::Box {
                return crate::server::cloud_tasks::run_box_setup_check(
                    &script,
                    &box_env,
                    box_network.unwrap_or_else(|| {
                        BoxNetworkPlan::plain(ryu_sandbox::box_session::BoxNetwork::None)
                    }),
                )
                .await;
            }
            if let (Some(backend), Some(key)) = (vpn_backend, vpn_key) {
                return backend.run_setup(&governed_spec, &key, &script, 120).await;
            }
            if governed {
                let backend = ryu_sandbox::opensandbox::OpenSandboxSandbox::governed();
                let workspace = backend.create(&governed_spec).await?;
                let result = backend.execute_script(&workspace, &script, 120).await;
                backend.destroy(&workspace).await?;
                return result;
            }
            let backend = ryu_sandbox::docker::DockerSandbox::new();
            let workspace = backend
                .create_workspace(SandboxCapabilities {
                    network,
                    ..SandboxCapabilities::default()
                })
                .await?;
            let result = backend
                .exec_in_workspace(
                    &workspace,
                    ExecSpec {
                        env: Vec::new(),
                        command: "sh".into(),
                        args: vec!["-s".into()],
                        stdin: Some(script.into_bytes()),
                        timeout_secs: Some(120),
                        capabilities: SandboxCapabilities {
                            network,
                            ..SandboxCapabilities::default()
                        },
                    },
                )
                .await;
            backend.destroy_workspace(&workspace).await?;
            result
        }
        .await;
        use crate::sidecar::gateway::{report_exec_audit_with_attribution, ExecAuditAttribution};
        report_exec_audit_with_attribution(
            backend_label,
            "cloud-environment-setup",
            started.elapsed().as_millis().min(u64::MAX as u128) as u64,
            result.as_ref().map_or(-1, |output| output.exit_code),
            None,
            result.as_ref().err().map(|_| "Setup runtime failed".into()),
            ExecAuditAttribution {
                user_id: audit_user_id,
                feature: Some("cloud-environment-setup".into()),
                ..Default::default()
            },
        )
        .await;
        result
    })
    .await
    .map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_runtime_unavailable",
            "The setup operation failed.",
        )
    })?
    .map_err(|_| {
        error(
            StatusCode::SERVICE_UNAVAILABLE,
            "cloud_environment_runtime_unavailable",
                "Setup failed, timed out, or could not clean up. Check the configured sandbox provider.",
        )
    })?;
    let redact = |bytes: Vec<u8>| {
        let mut text = String::from_utf8_lossy(&bytes).into_owned();
        for value in &secrets {
            if !value.is_empty() {
                text = text.replace(value, "[redacted]");
            }
        }
        text.chars().take(65536).collect::<String>()
    };
    Ok(Json(
        json!({"environmentId":id,"status":if output.exit_code == 0 {"completed"} else {"failed"},"exitCode":output.exit_code,"stdout":redact(output.stdout),"stderr":redact(output.stderr),"startInstructions":start_instructions}),
    ))
}
