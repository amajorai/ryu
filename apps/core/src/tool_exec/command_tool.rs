//! The governed `command` plugin-tool runner.
//!
//! Split out of `tool_exec/mod.rs`; items are re-exported there, so
//! `crate::tool_exec::*` paths are unchanged.

use super::*;

/// Variant of [`run_command_tool_with_agent`] for command tools that declare
/// caller-workspace path arguments or a `bin_version` requirement (the two
/// wrappers above pass neither, so they refuse any `egress_url_arg`; the MCP
/// dispatcher passes the manifest's).
/// The workspace root is resolved by the MCP registry from the server-owned
/// conversation context; passing it separately
/// keeps this generic command runner independent of conversation storage.
#[allow(clippy::too_many_arguments)]
pub async fn run_command_tool_with_agent_and_workspace(
    bin_key: &str,
    arg_templates: &[String],
    arg_specs: Option<&[crate::plugin_manifest::schema::ArgSpec]>,
    env_map: &BTreeMap<String, String>,
    cwd: Option<&str>,
    timeout_secs: u64,
    output: crate::plugin_manifest::schema::CommandOutput,
    egress_url_arg: Option<&str>,
    arg_bounds: &BTreeMap<String, crate::plugin_manifest::schema::ArgBounds>,
    mut args: Value,
    grants: &std::collections::HashSet<String>,
    plugin_id: &str,
    session_id: Option<&str>,
    audit_agent_id: Option<&str>,
    workspace_root: Option<&std::path::Path>,
    workspace_path_args: &[String],
    bin_version_req: Option<&crate::plugin_manifest::schema::CommandBinVersion>,
) -> Result<Value, String> {
    use crate::plugin_manifest::schema::CommandOutput;
    use tokio::io::AsyncReadExt;

    // 0. Schema-sourced defaults + clamp: inject each absent numeric arg's
    //    `default` and clamp a present one into `[minimum, maximum]`, sourced from
    //    the tool's own `input_schema`. Applied to BOTH the `command_args` and
    //    `arg_specs` render paths below, and it defends a raw-JSON caller that
    //    bypasses the MCP schema's own `minimum`/`maximum` (the original purpose).
    crate::plugin_manifest::schema::clamp_and_default_args(&mut args, arg_bounds);

    // 1. GRANT CHECK FIRST (deterministic refusal, before any I/O).
    let needed = format!("{GRANT_COMMAND_PREFIX}{bin_key}");
    let wildcard = format!("{GRANT_COMMAND_PREFIX}*");
    if !(grants.contains(&needed) || grants.contains(&wildcard)) {
        return Err(format!(
            "command tool: exec of '{bin_key}' is not granted (needs '{needed}')"
        ));
    }

    // 1b. EGRESS ⇒ VERSION: the egress broker only mediates a binary release that
    //     was verified to honour `HTTP(S)_PROXY`, so a URL-fetching command tool
    //     must never run unversioned. Manifest validation already requires
    //     `bin_version` alongside `egress_url_arg`; this runner-level refusal holds
    //     the same invariant for every entry point (including the wrappers above,
    //     which pass no requirement), before any I/O.
    if egress_url_arg.is_some() && bin_version_req.is_none() {
        return Err(format!(
            "command tool: '{bin_key}' declares egress_url_arg but no bin_version requirement \
             (the egress proxy only mediates a verified binary release)"
        ));
    }

    // 1c. BROKER SCOPE: the `vault:broker:<service>` grants the manifest
    //     declares. The per-invocation egress proxy owns a URL-fetching
    //     child's proxy variables, so the two never combine.
    let broker_scope = crate::vault::broker::command_tools::declared_services(grants.iter());
    if egress_url_arg.is_some() && !broker_scope.is_empty() {
        return Err(format!(
            "command tool: '{bin_key}' declares both egress_url_arg and a broker service scope"
        ));
    }

    let hidden = account_hidden_paths(audit_agent_id).await;
    prepare_workspace_path_args(&mut args, workspace_path_args, workspace_root, &hidden)?;

    // URL-fetching child: screen the URL argument first (fail fast on private,
    // internal, non-http(s), and disallowed-port targets), snapshotting the
    // policy the per-invocation egress broker will apply to EVERY connection the
    // child opens. The broker itself is started right before spawn.
    let egress_policy = match egress_url_arg {
        Some(arg_name) => Some(screen_command_egress_url(&args, arg_name, timeout_secs).await?),
        None => None,
    };

    // 2. ALLOWLIST RESOLUTION (the control): KEY → absolute path, file-verified.
    //    An UNKNOWN key stays a fail-closed `Err` (the allowlist is the security
    //    control); an allowlisted-but-not-installed bin degrades gracefully so the
    //    agent's turn continues (the seed-the-path → degrade-until-installed
    //    interplay between gaps #3 and #4).
    let abs_path = match resolve_command_bin(bin_key)? {
        BinResolution::Ready(path) => path,
        BinResolution::NotInstalled(reason) => return Ok(command_unavailable(reason)),
    };

    // 4. ENV (computed here so the version probe runs under the same posture):
    //    inherit → scrub secret-shaped keys. The declared overlay is layered below.
    let scrubbed = crate::sidecar::env_scrub::scrub_child_env(std::env::vars(), &[]);
    let mut child_env: BTreeMap<String, String> = scrubbed.into_iter().collect();

    // 2b. BINARY VERSION: a declared `bin_version` requirement is probed against
    //     the resolved binary (cached per path/size/mtime) and refused fail-closed
    //     when unparsable or out of range — before argv, Gateway, broker, or spawn.
    if let Some(requirement) = bin_version_req {
        let probe_timeout = bin_version::BIN_VERSION_PROBE_TIMEOUT
            .min(std::time::Duration::from_secs(timeout_secs.max(1)));
        bin_version::check_bin_version(bin_key, &abs_path, requirement, &child_env, probe_timeout)
            .await?;
    }

    // 3. ARGV BUILD (NO shell). Structured `arg_specs` (map/split) supersede the
    //    `command_args` template path when present — the map/split expansions the
    //    one-slot template model cannot express (rtk's zero-token mode + variadic
    //    shell-split command). Otherwise, one slot per template element.
    let argv: Vec<String> = match arg_specs {
        Some(specs) => expand_arg_specs(specs, &args)?,
        None => {
            let mut v = Vec::with_capacity(arg_templates.len());
            for tmpl in arg_templates {
                v.push(render_command_arg(tmpl, &args)?);
            }
            v
        }
    };

    // 3b. CONFINEMENT: a confined caller's child, or one given workspace
    //     paths, runs with the hidden stores masked (refused for a confined
    //     caller on a host that cannot sandbox).
    let (spawn_program, spawn_args) = command_confinement::command_spawn_program(
        &abs_path,
        &argv,
        !workspace_path_args.is_empty(),
        &hidden,
        crate::agent_sandbox::untrusted_support,
    )?;

    // 4b. ENV overlay: layer ONLY the declared vars onto the scrubbed base.
    //     Declared VALUES never enter the scan/audit content below.
    for (child_key, source) in env_map {
        // v1 supports only `env:VARNAME` — read Core's process env.
        if let Some(var) = source.strip_prefix("env:") {
            // SAME gate as the http tool's `secret_headers` (see `may_read_env_secret`).
            // This arm is the second `env:` reader in the crate and it is the more
            // dangerous of the two: a header value at least stays inside a request Core
            // builds, whereas this hands the raw value to a spawned child process that
            // can do anything with it. Without the gate a disk manifest could declare
            // `{"env": {"X": "env:ANTHROPIC_API_KEY"}}` on an allowlisted binary and
            // read any Core env var. Ungated → skipped, exactly like a missing var, so
            // Core's env inventory is not disclosed by a distinguishable error.
            if !may_read_env_secret(plugin_id, var) {
                tracing::warn!(
                    plugin_id,
                    var,
                    "command tool: refused an out-of-namespace env source"
                );
                continue;
            }
            // DELIBERATELY process-env ONLY: this arm does NOT fall back to
            // `crate::plugin_secrets` the way `resolve_secret_token` does. The
            // fallback exists so a UI-entered BYOK key can be interpolated into a
            // request header Core itself builds and sends to one known URL. Handing
            // that same key to a spawned child — which can exfiltrate it anywhere,
            // and whose whole reason for the scrubber above is to keep credentials
            // OUT of child environments — is a materially larger blast radius for no
            // demonstrated need (no in-repo command tool declares a BYOK key). If a
            // command tool ever needs one, wire it here explicitly and with its own
            // test, rather than by making the two paths implicitly symmetric.
            if let Ok(val) = std::env::var(var) {
                child_env.insert(child_key.clone(), val);
            }
            // A missing source var is silently skipped (the child just won't get it).
        } else {
            return Err(format!(
                "command tool: unsupported env source '{source}' for '{child_key}' (v1 supports only 'env:VARNAME')"
            ));
        }
    }

    // 5. GATEWAY governance: fail-closed budget + opt-in firewall/DLP scan.
    use crate::sidecar::gateway::{
        check_exec_budget, check_exec_scan, report_exec_audit_with_attribution,
        ExecAuditAttribution, ExecBudgetOutcome, ExecScanOutcome,
    };
    let audit_attribution = ExecAuditAttribution {
        agent_id: audit_agent_id
            .map(str::to_owned)
            .or_else(|| Some(plugin_id.to_owned())),
        feature: Some("agent".to_owned()),
        ..Default::default()
    };
    let backend = "tool_command";
    if let ExecBudgetOutcome::Deny(reason) = check_exec_budget(backend, "tool_command").await {
        return Err(format!("gateway denied command exec: {reason}"));
    }
    // Scan the bin + argv (the injection surface). Env VALUES are excluded — a
    // secret in a declared var never lands in the firewall/DLP scan or the audit.
    let scan_content = format!("{bin_key} {}", argv.join(" "));
    match check_exec_scan(backend, &scan_content, session_id, Some(plugin_id)).await {
        ExecScanOutcome::Allow => {}
        // ApprovalRequired is a fail-closed DENY on a synchronous exec: there is no
        // place to park an interactive sign-off in a blocking tool call.
        ExecScanOutcome::Deny(reason) | ExecScanOutcome::ApprovalRequired(reason) => {
            report_exec_audit_with_attribution(
                backend,
                "tool_command",
                0,
                1,
                session_id.map(str::to_owned),
                Some(format!("scan denied: {reason}")),
                audit_attribution.clone(),
            )
            .await;
            return Err(format!("gateway denied command exec: {reason}"));
        }
    }

    // 5b. EGRESS BROKER for URL-fetching children: a loopback forward proxy with
    //     a random per-invocation credential that re-screens and IP-pins every
    //     connection. Installed AFTER the declared env so a manifest cannot
    //     override the proxy variables or exempt hosts through `NO_PROXY`. The
    //     handle lives until this function returns (child exited or killed) and
    //     its lifetime is capped at the tool timeout.
    let _egress_broker = match egress_policy {
        Some(policy) => {
            let broker = egress_broker::EgressBroker::start(policy)
                .await
                .map_err(|e| format!("command tool: failed to start egress broker: {e}"))?;
            broker.apply_to_env(&mut child_env);
            Some(broker)
        }
        None => None,
    };

    // 5c. CREDENTIAL BROKER for a declared service scope: a per-invocation
    //     `rvb_` session over the declared services, revoked when this function
    //     returns. Fails closed: a scope that cannot be honoured never spawns.
    //     Installed after the declared env, like the egress proxy.
    let _vault_broker =
        match broker_session(plugin_id, &broker_scope, audit_agent_id, timeout_secs).await {
            Ok(lease) => lease,
            Err(reason) => return Ok(command_unavailable(format!("command tool: {reason}"))),
        };
    if let Some(lease) = _vault_broker.as_ref() {
        apply_proxy_env(&mut child_env, lease.env());
    }

    // 6. SPAWN — argv array, cleared+declared env, piped stdout/stderr, no stdin.
    let started = std::time::Instant::now();
    let mut cmd = tokio::process::Command::new(&spawn_program);
    cmd.args(&spawn_args).env_clear();
    for (k, v) in &child_env {
        cmd.env(k, v);
    }
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    cmd.stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .kill_on_drop(true);

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            report_exec_audit_with_attribution(
                backend,
                "tool_command",
                started.elapsed().as_millis() as u64,
                1,
                session_id.map(str::to_owned),
                Some(e.to_string()),
                audit_attribution.clone(),
            )
            .await;
            // OPERATIONAL failure → graceful degradation (audit still records the
            // real error above via exit 1). Turn-continuation, not a hard error.
            return Ok(command_unavailable(format!(
                "command tool: failed to spawn '{bin_key}': {e}"
            )));
        }
    };

    // Read stdout (bounded) and drain stderr CONCURRENTLY in separate tasks so a
    // full stderr pipe cannot deadlock the child while we wait on it.
    let mut stdout = child
        .stdout
        .take()
        .ok_or_else(|| "command tool: no stdout pipe".to_owned())?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or_else(|| "command tool: no stderr pipe".to_owned())?;
    let out_task = tokio::spawn(async move {
        let mut buf = Vec::new();
        {
            let mut limited = (&mut stdout).take(MAX_COMMAND_OUTPUT_BYTES as u64);
            let _ = limited.read_to_end(&mut buf).await;
        }
        // Drain any remainder past the cap so the child never blocks writing.
        let mut scratch = [0u8; 8192];
        while let Ok(n) = stdout.read(&mut scratch).await {
            if n == 0 {
                break;
            }
        }
        buf
    });
    let err_task = tokio::spawn(async move {
        // Capture stderr (bounded, same cap as stdout) so a successful command's
        // diagnostics — which many CLIs write to stderr — survive into the result.
        let mut buf = Vec::new();
        {
            let mut limited = (&mut stderr).take(MAX_COMMAND_OUTPUT_BYTES as u64);
            let _ = limited.read_to_end(&mut buf).await;
        }
        // Drain any remainder past the cap so the child never blocks writing.
        let mut scratch = [0u8; 8192];
        while let Ok(n) = stderr.read(&mut scratch).await {
            if n == 0 {
                break;
            }
        }
        buf
    });

    // 7. Hard timeout + explicit kill.
    let status = match tokio::time::timeout(
        std::time::Duration::from_secs(timeout_secs),
        child.wait(),
    )
    .await
    {
        Ok(Ok(status)) => status,
        Ok(Err(e)) => {
            out_task.abort();
            err_task.abort();
            return Err(format!("command tool: wait on '{bin_key}' failed: {e}"));
        }
        Err(_elapsed) => {
            let _ = child.start_kill();
            let _ = child.wait().await;
            out_task.abort();
            err_task.abort();
            report_exec_audit_with_attribution(
                backend,
                "tool_command",
                started.elapsed().as_millis() as u64,
                124,
                session_id.map(str::to_owned),
                Some(format!("timeout after {timeout_secs}s")),
                audit_attribution.clone(),
            )
            .await;
            // OPERATIONAL failure → graceful degradation (audit records exit 124
            // above). Turn-continuation posture, mirroring the deleted providers.
            return Ok(command_unavailable(format!(
                "command tool: '{bin_key}' timed out after {timeout_secs}s"
            )));
        }
    };
    let stdout_bytes = out_task.await.unwrap_or_default();
    let stderr_bytes = err_task.await.unwrap_or_default();

    let exit_code = status.code().unwrap_or(-1);
    report_exec_audit_with_attribution(
        backend,
        "tool_command",
        started.elapsed().as_millis() as u64,
        exit_code,
        session_id.map(str::to_owned),
        None,
        audit_attribution,
    )
    .await;

    let truncated = stdout_bytes.len() >= MAX_COMMAND_OUTPUT_BYTES
        || stderr_bytes.len() >= MAX_COMMAND_OUTPUT_BYTES;
    let stdout_str = String::from_utf8_lossy(&stdout_bytes).into_owned();
    let stderr_str = String::from_utf8_lossy(&stderr_bytes).into_owned();
    // A non-zero exit is returned as `Ok` (the exit code is in the payload +
    // audit), deliberately consistent with `run_http_tool` returning a non-2xx as
    // Ok — the caller/agent decides what a failed command means.
    match output {
        // Merge non-empty stderr into the returned text: many CLIs write
        // progress/warnings/diagnostics to stderr on an OTHERWISE successful run,
        // and the original merged-provider contract surfaced them (dropping them
        // silently masked useful output). General behavior, not tool-specific.
        CommandOutput::Stdout => Ok(serde_json::json!({
            "exit_code": exit_code,
            "stdout": merge_stderr(stdout_str, &stderr_str),
            "truncated": truncated,
        })),
        // Non-JSON stdout under output=json degrades gracefully (spider's posture,
        // chosen as the generic contract): the agent still receives the raw text
        // as `content` rather than losing the turn to a hard parse error.
        CommandOutput::Json => match serde_json::from_str::<Value>(stdout_str.trim()) {
            // Structured JSON stdout is returned verbatim: it has no free-text
            // field, and splicing stderr in would corrupt the parsed value.
            Ok(v) => Ok(v),
            // A stream past the cap is cut mid-document, so it lands here too; say so
            // rather than hand the agent half a JSON envelope as if it were whole.
            Err(_) => Ok(serde_json::json!({
                "available": true,
                "content": merge_stderr(stdout_str, &stderr_str),
                "exit_code": exit_code,
                "truncated": truncated,
            })),
        },
    }
}
