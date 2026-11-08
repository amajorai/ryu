//! Structured command arguments, the command-tool entry points, and the
//! URL screen for egress-fetching children.
//!
//! Split out of `tool_exec/mod.rs`; items are re-exported there, so
//! `crate::tool_exec::*` paths are unchanged.

use super::*;

/// Build argv from a structured [`ArgSpec`] list (the `command_args` template
/// grammar's superset). Each spec reads one call arg and expands to 0..N tokens:
///
///   - `map` + `default`: the arg's string value is a KEY selecting the token
///     list; a key mapping to `[]` emits nothing (rtk `mode:"wrap"` → no
///     subcommand). An absent arg falls back to `default`; a value with no
///     matching key (and no usable default) is an error.
///   - `split:"shell"`: the arg's string value is `shell_words`-split into
///     variadic argv (quotes honored, never a shell). The split tokens are NOT
///     option-injection-guarded (a wrapped command legitimately carries `-la` /
///     `--all`); the bin grant + exec-scan are the controls, exactly as they were
///     for the deleted native provider. A `required` spec errors on a blank arg.
///   - neither: the arg's scalar value is emitted as ONE guarded token (same
///     leading-`-` guard + length cap as [`render_command_arg`]).
///
/// No shell is ever involved — the result is a plain argv array.
pub(super) fn expand_arg_specs(
    specs: &[crate::plugin_manifest::schema::ArgSpec],
    args: &Value,
) -> Result<Vec<String>, String> {
    let obj = args.as_object();
    let mut argv: Vec<String> = Vec::new();
    for spec in specs {
        let raw = obj.and_then(|o| o.get(&spec.from));
        if let Some(map) = &spec.map {
            // Enum-map: the arg's string value is a key. Absent → `default`.
            let key: String = match raw.and_then(Value::as_str) {
                Some(s) => s.to_owned(),
                None => spec.default.clone().ok_or_else(|| {
                    format!("command tool: missing required argument '{}'", spec.from)
                })?,
            };
            let tokens = map.get(&key).ok_or_else(|| {
                format!(
                    "command tool: argument '{}' has unknown value '{key}'",
                    spec.from
                )
            })?;
            for t in tokens {
                argv.push(t.clone());
            }
        } else if spec.split.as_deref() == Some("shell") {
            // Shell-split one string arg into variadic argv — quotes honored,
            // never handed to a shell (metacharacters stay literal args).
            let s = raw.and_then(Value::as_str).unwrap_or_default().trim();
            if s.is_empty() {
                if spec.required.unwrap_or(false) {
                    return Err(format!(
                        "command tool: argument '{}' must be a non-empty string",
                        spec.from
                    ));
                }
                continue;
            }
            match shell_words::split(s) {
                Ok(parts) if !parts.is_empty() => {
                    for p in parts {
                        if p.len() > MAX_COMMAND_ARG_LEN {
                            return Err(format!(
                                "command tool: a token of argument '{}' exceeds {MAX_COMMAND_ARG_LEN} bytes",
                                spec.from
                            ));
                        }
                        argv.push(p);
                    }
                }
                Ok(_) => {
                    if spec.required.unwrap_or(false) {
                        return Err(format!(
                            "command tool: argument '{}' must be a non-empty string",
                            spec.from
                        ));
                    }
                }
                Err(e) => {
                    return Err(format!(
                        "command tool: could not parse argument '{}' ({e}); check quoting",
                        spec.from
                    ))
                }
            }
        } else {
            // Plain single token — same guards as a `command_args` interpolation.
            match raw {
                Some(v) => {
                    let rendered = scalar_to_string(v).ok_or_else(|| {
                        format!("command tool: argument '{}' must be a scalar", spec.from)
                    })?;
                    if rendered.len() > MAX_COMMAND_ARG_LEN {
                        return Err(format!(
                            "command tool: argument '{}' exceeds {MAX_COMMAND_ARG_LEN} bytes",
                            spec.from
                        ));
                    }
                    if rendered.starts_with('-') {
                        return Err(format!(
                            "command tool: argument '{}' may not begin with '-' (option-injection guard)",
                            spec.from
                        ));
                    }
                    argv.push(rendered);
                }
                None => {
                    if spec.required.unwrap_or(false) {
                        return Err(format!(
                            "command tool: missing required argument '{}'",
                            spec.from
                        ));
                    }
                }
            }
        }
    }
    Ok(argv)
}

/// Exec an allowlisted local CLI as a declarative `command` plugin tool —
/// Gateway-governed and bin-grant-gated. The exact `run_http_tool` bracket: the
/// **grant check runs first** (deterministic, no I/O), then the Core-controlled
/// **allowlist resolution** (the control), then arg templating into an argv ARRAY
/// (never a shell string), then the SAME budget + exec-approval scan + audit the
/// PTC/http paths use, and only then the spawn — under a hard timeout with a
/// bounded stdout read and a concurrent stderr drain.
///
/// `grants` is the owning plugin's grant set; it must contain
/// `tool:command:<bin>` (or the `*` wildcard). Env VALUES are deliberately
/// excluded from the scan and audit content, mirroring how `http` excludes header
/// values. `plugin_id` remains the grant and secret namespace, while
/// `audit_agent_id` preserves the actual agent that invoked the tool when the
/// dispatcher has that context.
#[allow(clippy::too_many_arguments)]
pub async fn run_command_tool(
    bin_key: &str,
    arg_templates: &[String],
    arg_specs: Option<&[crate::plugin_manifest::schema::ArgSpec]>,
    env_map: &BTreeMap<String, String>,
    cwd: Option<&str>,
    timeout_secs: u64,
    output: crate::plugin_manifest::schema::CommandOutput,
    egress_url_arg: Option<&str>,
    arg_bounds: &BTreeMap<String, crate::plugin_manifest::schema::ArgBounds>,
    args: Value,
    grants: &std::collections::HashSet<String>,
    plugin_id: &str,
    session_id: Option<&str>,
) -> Result<Value, String> {
    run_command_tool_with_agent(
        bin_key,
        arg_templates,
        arg_specs,
        env_map,
        cwd,
        timeout_secs,
        output,
        egress_url_arg,
        arg_bounds,
        args,
        grants,
        plugin_id,
        session_id,
        None,
    )
    .await
}

/// Variant of [`run_command_tool`] that preserves the calling agent id while
/// keeping the owning plugin id as the grant/secret boundary.
#[allow(clippy::too_many_arguments)]
pub async fn run_command_tool_with_agent(
    bin_key: &str,
    arg_templates: &[String],
    arg_specs: Option<&[crate::plugin_manifest::schema::ArgSpec]>,
    env_map: &BTreeMap<String, String>,
    cwd: Option<&str>,
    timeout_secs: u64,
    output: crate::plugin_manifest::schema::CommandOutput,
    egress_url_arg: Option<&str>,
    arg_bounds: &BTreeMap<String, crate::plugin_manifest::schema::ArgBounds>,
    args: Value,
    grants: &std::collections::HashSet<String>,
    plugin_id: &str,
    session_id: Option<&str>,
    audit_agent_id: Option<&str>,
) -> Result<Value, String> {
    run_command_tool_with_agent_and_workspace(
        bin_key,
        arg_templates,
        arg_specs,
        env_map,
        cwd,
        timeout_secs,
        output,
        egress_url_arg,
        arg_bounds,
        args,
        grants,
        plugin_id,
        session_id,
        audit_agent_id,
        None,
        &[],
        None,
    )
    .await
}

/// Pre-spawn screen for a command tool's `egress_url_arg`: the URL must be a
/// string, pass Core's agent egress screen ([`crate::server::screen_agent_egress_url`]:
/// http/https only, internal hosts and private/loopback/metadata addresses refused
/// unless allowlisted), and use a port the egress broker will permit. Returns the
/// broker policy snapshot so the URL screen and the per-connection screen agree.
pub(super) async fn screen_command_egress_url(
    args: &Value,
    arg_name: &str,
    timeout_secs: u64,
) -> Result<egress_broker::BrokerPolicy, String> {
    let raw = args.get(arg_name).and_then(Value::as_str).ok_or_else(|| {
        format!("command tool: egress URL argument '{arg_name}' must be a string")
    })?;
    let parsed = crate::server::screen_agent_egress_url(raw)
        .await
        .map_err(|e| format!("command tool: egress URL refused: {e}"))?;
    let policy =
        egress_broker::BrokerPolicy::from_env(std::time::Duration::from_secs(timeout_secs));
    let host = parsed.host_str().unwrap_or_default();
    let port = parsed.port_or_known_default().unwrap_or(80);
    policy
        .check_port(host, port)
        .map_err(|e| format!("command tool: egress URL refused: {e}"))?;
    Ok(policy)
}

/// Append non-empty `stderr` to a command's `text` output, matching the original
/// merged-provider contract: a single `\n` separates them only when `text` is
/// non-empty and does not already end in a newline. Whitespace-only stderr is
/// dropped.
pub(super) fn merge_stderr(mut text: String, stderr: &str) -> String {
    if !stderr.trim().is_empty() {
        if !text.is_empty() && !text.ends_with('\n') {
            text.push('\n');
        }
        text.push_str(stderr);
    }
    text
}

/// The broker session for a command tool's declared service scope, if any.
pub(super) async fn broker_session(
    plugin_id: &str,
    scope: &[String],
    agent_id: Option<&str>,
    timeout_secs: u64,
) -> Result<Option<crate::vault::broker::runtime::RuntimeBrokerLease>, String> {
    if scope.is_empty() {
        return Ok(None);
    }
    let account_confined = match (agent_id, crate::agents::global()) {
        (Some(agent_id), Some(store)) => {
            crate::agent_access::account_confinement_for_agent(store, agent_id)
                .await
                .is_confined()
        }
        // An agent whose access cannot be read is treated as limited.
        (Some(_), None) => true,
        (None, _) => false,
    };
    crate::vault::broker::command_tools::lease_for_command(
        plugin_id,
        scope,
        account_confined,
        false,
        timeout_secs,
    )
    .await
    .map_err(|refusal| refusal.to_string())
}

/// Layer the broker's proxy variables over the child environment, dropping
/// every case variant first so nothing declared can redirect or exempt the
/// brokered traffic.
pub(super) fn apply_proxy_env(
    child_env: &mut BTreeMap<String, String>,
    broker_env: &BTreeMap<String, String>,
) {
    child_env.retain(|name, _| !broker_env.keys().any(|key| key.eq_ignore_ascii_case(name)));
    child_env.extend(
        broker_env
            .iter()
            .map(|(name, value)| (name.clone(), value.clone())),
    );
}

#[cfg(test)]
#[path = "broker_scope_tests.rs"]
mod broker_scope_tests;
