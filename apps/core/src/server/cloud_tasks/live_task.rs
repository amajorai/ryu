//! A live task's commands, bound tool execution and route preambles.

use super::leases::remove_lease;
use super::*;

impl LiveTask {
    pub(super) fn new(
        context: CloudTaskContext,
        profile: environments::PreparedEnvironment,
        workspace: TaskWorkspace,
        expires_at: u64,
        lease_id: String,
        conversation_id: String,
        authority: ResolvedAuthorization,
    ) -> Self {
        Self {
            context,
            profile,
            workspace,
            expires_at,
            lease_id,
            conversation_id,
            authority,
            base_sha: None,
            base_branch: None,
            metered: false,
            metering: None,
            active_run: None,
            last_run: None,
            finish: None,
            finishing: false,
        }
    }
    pub(super) async fn run(&self, script: &str, seconds: u64) -> Result<ExecOutput> {
        let routed;
        let script = match self.desktop_route_preamble().await? {
            Some(preamble) => {
                routed = format!("{preamble}{script}");
                routed.as_str()
            }
            None => script,
        };
        match &self.workspace {
            TaskWorkspace::Box(workspace) => {
                crate::server::session_box::box_client()
                    .await?
                    .exec_script(
                        workspace,
                        script,
                        &self.profile.box_env,
                        ryu_sandbox::box_session::BoxUser::Box,
                        seconds,
                    )
                    .await
            }
            TaskWorkspace::Vpn(workspace) => {
                self.profile
                    .vpn_backend
                    .as_ref()
                    .ok_or_else(|| anyhow!("VPN runtime unavailable"))?
                    .execute_script(workspace, script, seconds)
                    .await
            }
            TaskWorkspace::Governed(workspace) => {
                ryu_sandbox::opensandbox::OpenSandboxSandbox::governed()
                    .execute_script(workspace, script, seconds)
                    .await
            }
            TaskWorkspace::Docker(workspace) => {
                ryu_sandbox::docker::DockerSandbox::new()
                    .exec_in_workspace(
                        workspace,
                        ExecSpec {
                            env: Vec::new(),
                            command: "sh".into(),
                            args: vec!["-s".into()],
                            stdin: Some(script.as_bytes().to_vec()),
                            timeout_secs: Some(seconds),
                            capabilities: SandboxCapabilities {
                                network: self.profile.network,
                                ..Default::default()
                            },
                        },
                    )
                    .await
            }
        }
    }
    /// Proxy exports that send this task's web traffic through the user's
    /// desktop while "Route traffic through this computer" is on. Fails closed:
    /// a routed node never runs a networked task that cannot reach the route.
    pub(super) async fn desktop_route_preamble(&self) -> Result<Option<String>> {
        if !self.profile.network {
            return Ok(None);
        }
        route_preamble(
            true,
            crate::local_egress::entry::routing_active().await,
            matches!(self.workspace, TaskWorkspace::Docker(_)),
            crate::local_egress::entry::container_proxy_env,
        )
    }
    pub(super) async fn destroy(&self) -> Result<()> {
        match &self.workspace {
            TaskWorkspace::Vpn(workspace) => {
                self.profile
                    .vpn_backend
                    .as_ref()
                    .ok_or_else(|| anyhow!("VPN runtime unavailable"))?
                    .destroy_workspace(workspace)
                    .await
            }
            TaskWorkspace::Governed(workspace) => {
                ryu_sandbox::opensandbox::OpenSandboxSandbox::governed()
                    .destroy(workspace)
                    .await
            }
            TaskWorkspace::Docker(_) => {
                ryu_sandbox::docker::DockerSandbox::new()
                    .destroy_leased_workspace(&self.lease_id, self.expires_at)
                    .await
            }
            // Billing, prompt cancel and lease removal are Box-specific.
            TaskWorkspace::Box(workspace) => return box_arm::destroy(self, workspace).await,
        }?;
        remove_lease(&self.lease_id)
    }
    pub(super) fn output(&self, output: ExecOutput) -> Value {
        let redact = |bytes: Vec<u8>| {
            let mut text = String::from_utf8_lossy(&bytes).into_owned();
            for secret in &self.profile.task_redactions {
                if !secret.is_empty() {
                    text = text.replace(secret, "[redacted]");
                }
            }
            text.chars().take(65536).collect::<String>()
        };
        json!({"exitCode":output.exit_code,"stdout":redact(output.stdout),"stderr":redact(output.stderr)})
    }
}

/// One disposable Box setup check for `POST /api/cloud-environments/{id}/launch`.
pub(in crate::server) async fn run_box_setup_check(
    script: &str,
    env: &[(String, String)],
    network: environments::BoxNetworkPlan,
) -> Result<ExecOutput> {
    box_arm::setup_check(script, env, network).await
}

pub(crate) async fn execute_bound_tool(
    owner: &str,
    conversation_id: &str,
    tool: &str,
    arguments: Value,
) -> Result<Value> {
    let slot = tasks()
        .lock()
        .await
        .get(&(owner.to_owned(), conversation_id.to_owned()))
        .cloned()
        .ok_or_else(|| anyhow!("No cloud task is bound to this verified conversation"))?;
    let mut state = slot.lock().await;
    let TaskState::Ready(task) = &*state else {
        bail!("Cloud task is not ready");
    };
    require_execution(&task.authority)
        .map_err(|_| anyhow!("Cloud task execution authority expired or was denied"))?;
    if task.context.executor != "ryu" {
        bail!("This cloud task runs a managed agent");
    }
    if task.expires_at <= now()? {
        task.destroy().await?;
        *state = TaskState::Stopped;
        bail!("Cloud task expired");
    }
    environments::approve_network_policy(
        &task.profile.governed_spec,
        task.profile.vpn_key.is_some(),
    )
    .await
    .map_err(|_| anyhow!("Gateway denied cloud task egress"))?;
    environments::approve_setup_budget(task.profile.backend_label)
        .await
        .map_err(|_| anyhow!("Gateway denied cloud task execution"))?;
    let script = tool_script(&task.context.working_directory, tool, &arguments)?;
    let script = format!("{}\n{script}", task.profile.task_preamble);
    let remaining = task.expires_at.saturating_sub(now()?);
    ensure!(remaining > 0, "Cloud task expired before execution");
    let output = task.run(&script, 120.min(remaining)).await?;
    Ok(task.output(output))
}

pub(super) fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}
/// Builds the proxy exports prepended to a networked task's script while desktop
/// routing is on. Fails closed for sandboxes that cannot reach the route; the
/// proxy variables are only resolved once the Docker check has passed.
pub(super) fn route_preamble(
    network: bool,
    routing: bool,
    docker: bool,
    proxy_env: impl FnOnce() -> Option<Vec<(&'static str, String)>>,
) -> Result<Option<String>> {
    if !network || !routing {
        return Ok(None);
    }
    ensure!(
        docker,
        "This environment's sandbox cannot route through your desktop. Turn off \"Route traffic through this computer\" to run it from the cloud."
    );
    let variables = proxy_env().ok_or_else(|| {
        anyhow!("Desktop routing is on, but task containers cannot reach the route on this node")
    })?;
    Ok(Some(
        variables
            .into_iter()
            .map(|(key, value)| format!("export {key}={}\n", quote(&value)))
            .collect(),
    ))
}
pub(super) fn relative_path(arguments: &Value) -> Result<&str> {
    let path = arguments["path"]
        .as_str()
        .ok_or_else(|| anyhow!("A relative workspace path is required"))?;
    ensure!(
        !path.is_empty()
            && path.len() <= 4096
            && !path.contains(['\0', '\\', '\n', '\r'])
            && !path.starts_with('/')
            && !path.split('/').any(|part| part == ".."),
        "Path must stay inside the cloud working directory"
    );
    Ok(path)
}
pub(super) fn tool_script(root: &str, tool: &str, arguments: &Value) -> Result<String> {
    let object = arguments
        .as_object()
        .ok_or_else(|| anyhow!("Cloud tool arguments must be an object"))?;
    let fields: &[&str] = match tool {
        "exec" => &["command"],
        "read_file" | "list_files" => &["path"],
        "write_file" => &["path", "content"],
        _ => bail!("Unsupported cloud task tool"),
    };
    ensure!(
        object.keys().all(|field| fields.contains(&field.as_str())),
        "Cloud tools do not accept workspace or policy overrides"
    );
    if tool == "exec" {
        let command = arguments["command"]
            .as_str()
            .ok_or_else(|| anyhow!("A command is required"))?;
        ensure!(
            command.len() <= 65536 && !command.contains('\0'),
            "Command exceeds limits"
        );
        return Ok(format!("sh -c {}\n", quote(command)));
    }
    let path = relative_path(arguments)?;
    // realpath follows symlinks inside the container; no host path is ever read.
    let guard = format!("root={}\npath=$(realpath -m -- {})\ncase \"$path\" in \"$root\"|\"$root\"/*) ;; *) exit 65;; esac\n", quote(root), quote(path));
    let body = match tool {
        "read_file" => "head -c 65536 -- \"$path\"\n".to_owned(),
        "list_files" => "find \"$path\" -maxdepth 2 -type f -print | head -n 1000\n".to_owned(),
        "write_file" => {
            let content = arguments["content"]
                .as_str()
                .ok_or_else(|| anyhow!("Text content is required"))?;
            ensure!(
                content.len() <= 65536 && !content.contains('\0'),
                "Content exceeds limits"
            );
            format!(
                "mkdir -p -- \"$(dirname -- \"$path\")\"\nprintf '%s' {} > \"$path\"\n",
                quote(content)
            )
        }
        _ => bail!("Unsupported cloud task tool"),
    };
    Ok(guard + &body)
}
