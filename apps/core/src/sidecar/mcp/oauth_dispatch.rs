//! OAuth, MPP payment and builder-policy helpers for MCP dispatch.

use super::*;

pub(super) fn oauth_http_failure(error: &anyhow::Error, status: reqwest::StatusCode) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<client::McpHttpFailure>()
            .is_some_and(|failure| failure.status == status)
    })
}

pub(super) fn url_for_calling_agent(
    url: &str,
    query_param: Option<&str>,
    agent_id: Option<&str>,
) -> Result<String> {
    let (Some(query_param), Some(agent_id)) = (query_param, agent_id) else {
        return Ok(url.to_owned());
    };
    let mut parsed = url::Url::parse(url).context("invalid HTTP tool URL")?;
    if parsed.query_pairs().any(|(name, _)| name == query_param) {
        bail!("HTTP tool URL already contains Core-owned query parameter '{query_param}'");
    }
    parsed.query_pairs_mut().append_pair(query_param, agent_id);
    Ok(parsed.into())
}

pub(super) fn oauth_challenge_header(error: &anyhow::Error) -> Option<String> {
    error.chain().find_map(|cause| {
        cause
            .downcast_ref::<client::McpHttpFailure>()
            .and_then(|failure| failure.www_authenticate.clone())
    })
}

fn mpp_target(server: &str, tool: &str) -> Value {
    serde_json::json!({ "kind": "mcp_tool", "server": server, "tool": tool })
}

pub(super) fn mpp_payment_required(
    error: &anyhow::Error,
    server: &str,
    tool: &str,
) -> Option<Value> {
    for cause in error.chain() {
        if let Some(failure) = cause.downcast_ref::<client::McpRpcFailure>() {
            if failure.code == crate::payment::MCP_PAYMENT_REQUIRED_CODE {
                let data = failure.data.as_ref()?;
                return crate::payment::PaymentRequiredEnvelope::mcp(
                    data,
                    mpp_target(server, tool),
                )
                .map(crate::payment::PaymentRequiredEnvelope::into_value);
            }
        }
        if let Some(failure) = cause.downcast_ref::<client::McpHttpFailure>() {
            if failure.status == reqwest::StatusCode::PAYMENT_REQUIRED {
                let header = failure.www_authenticate.as_deref()?;
                return crate::payment::PaymentRequiredEnvelope::http(
                    header,
                    mpp_target(server, tool),
                )
                .map(crate::payment::PaymentRequiredEnvelope::into_value);
            }
        }
    }
    None
}

fn mpp_payment_required_result(result: &Value, server: &str, tool: &str) -> Option<Value> {
    let data = result
        .get("_meta")?
        .get("org.paymentauth/payment-required")?;
    crate::payment::PaymentRequiredEnvelope::mcp_metadata(data, mpp_target(server, tool))
        .map(crate::payment::PaymentRequiredEnvelope::into_value)
}

pub(super) fn normalize_mpp_result(result: Value, server: &str, tool: &str) -> Value {
    mpp_payment_required_result(&result, server, tool).unwrap_or(result)
}

pub(super) fn oauth_requires_connect(error: &anyhow::Error) -> bool {
    let message = error.to_string();
    message.contains("authentication required")
        || message.contains("reconnect required")
        || message.contains("has no refresh token")
}

/// Workflows and dashboards run with the user's accounts, outside any one
/// agent's account policy, so only an unrestricted agent may create or change
/// them through the built-in builders. This mirrors the Self-API, where the
/// writes of every other agent (its own identity, both, or an allowlist) are
/// confined to `RESTRICTED_SAFE_WRITES`.
pub(super) fn require_unrestricted_for_builder(
    policy: Option<&crate::agent_access::AgentAccountPolicy>,
    what: &str,
) -> Result<()> {
    if policy.is_some_and(|policy| !policy.is_unrestricted()) {
        bail!(
            "this agent has accounts of its own or limited account access, so it cannot create or change {what} that run with your accounts"
        );
    }
    Ok(())
}

pub(super) fn oauth_owner_from_principal(principal: &ToolPrincipal) -> Result<String> {
    match principal {
        ToolPrincipal::Unrestricted => crate::mcp_oauth::owner_for_caller(None),
        ToolPrincipal::Owned { user_id, .. } => Ok(user_id.clone()),
        ToolPrincipal::Unresolved => {
            bail!("a verified user identity is required for MCP OAuth on a shared node")
        }
    }
}

/// `policy` is the calling agent's account policy (`None` for agent-less
/// discovery). Every candidate profile, the default one included, is a sign-in
/// of the user's, so an agent with its own identity is refused outright and a
/// restricted agent keeps only the sign-ins on its allowlist.
pub(super) async fn oauth_profile_for(
    owner_user_id: &str,
    cfg: &McpServerConfig,
    profile_ids: &[String],
    agent_id: Option<&str>,
    policy: Option<&crate::agent_access::AgentAccountPolicy>,
) -> Result<String> {
    let plugin_id = cfg
        .owner_plugin_id
        .as_deref()
        .context("OAuth MCP server has no owning plugin")?;
    let server_name = cfg
        .owner_server_name
        .as_deref()
        .context("OAuth MCP server has no owning manifest key")?;
    if policy.is_some_and(|policy| !policy.allows_user_accounts()) {
        bail!(
            "this agent works under its own identity and cannot use your sign-in for MCP server '{server_name}'"
        );
    }
    let candidates: Vec<&str> = if profile_ids.is_empty() {
        vec![crate::mcp_oauth::default_profile_id()]
    } else {
        profile_ids.iter().map(String::as_str).collect()
    };
    let candidates: Vec<&str> = candidates
        .into_iter()
        .filter(|profile| {
            policy.is_none_or(|policy| policy.allows_mcp(profile, plugin_id, server_name))
        })
        .collect();
    if candidates.is_empty() {
        bail!("this agent is not allowed to use your sign-in for MCP server '{server_name}'");
    }
    if crate::mcp_oauth::remote_configured() {
        let agent = agent_id.context("Passport MCP requires an explicit calling agent")?;
        if profile_ids.is_empty() {
            bail!("Passport MCP requires explicitly bound identity profiles");
        }
        let mut connected = Vec::new();
        for profile in &candidates {
            let binding = ryu_vault::mcp_oauth::McpBinding {
                owner_user_id: owner_user_id.to_owned(),
                profile_id: (*profile).to_owned(),
                plugin_id: plugin_id.to_owned(),
                server_name: server_name.to_owned(),
                resource_url: cfg
                    .url
                    .clone()
                    .context("OAuth MCP server has no resource URL")?,
                client_id: cfg
                    .auth
                    .as_ref()
                    .and_then(crate::plugin_manifest::McpServerAuthDecl::client_id)
                    .map(str::to_owned),
            };
            if crate::identity::passport::mcp_metadata_configured(
                agent,
                &binding,
                &oauth_configuration(cfg)?,
            )
            .await?
            .is_some_and(|value| value["status"] == "connected")
            {
                connected.push((*profile).to_owned());
            }
        }
        return match connected.as_slice() {
            [profile] => Ok(profile.clone()),
            [] => Ok(candidates[0].to_owned()),
            _ => bail!(
                "multiple bound identity profiles are connected to this MCP server; select one profile explicitly"
            ),
        };
    }
    let Some(store) = crate::identity::global() else {
        return Ok(candidates[0].to_owned());
    };
    let mut connected = Vec::new();
    for profile_id in &candidates {
        if store
            .find_mcp_oauth_connection(owner_user_id, profile_id, plugin_id, server_name)
            .await?
            .is_some_and(|connection| {
                connection.status == crate::identity::McpOAuthConnectionStatus::Connected
            })
        {
            connected.push((*profile_id).to_owned());
        }
    }
    match connected.as_slice() {
        [profile_id] => Ok(profile_id.clone()),
        [] => Ok(candidates[0].to_owned()),
        _ => bail!(
            "multiple bound identity profiles are connected to this MCP server; select one profile explicitly"
        ),
    }
}

pub(super) async fn oauth_target(
    cfg: &McpServerConfig,
    owner_user_id: &str,
    profile_id: &str,
    action: crate::identity::ConnectionAction,
    risk_approved: bool,
    force_refresh: bool,
    session_id: Option<String>,
    agent_id: Option<&str>,
) -> Result<McpTarget> {
    let mut target = cfg.to_target()?;
    let Some(_) = cfg.auth else {
        return Ok(target);
    };
    let plugin_id = cfg
        .owner_plugin_id
        .as_deref()
        .context("OAuth MCP server has no owning plugin")?;
    let server_name = cfg
        .owner_server_name
        .as_deref()
        .context("OAuth MCP server has no owning manifest key")?;
    let resource = cfg
        .url
        .as_deref()
        .context("OAuth MCP server has no resource URL")?;
    if crate::mcp_oauth::remote_configured() {
        return crate::identity::passport::mcp_target_configured(
            agent_id.context("Passport MCP requires an explicit calling agent")?,
            ryu_vault::mcp_oauth::McpBinding {
                owner_user_id: owner_user_id.to_owned(),
                profile_id: profile_id.to_owned(),
                plugin_id: plugin_id.to_owned(),
                server_name: server_name.to_owned(),
                resource_url: resource.to_owned(),
                client_id: cfg
                    .auth
                    .as_ref()
                    .and_then(crate::plugin_manifest::McpServerAuthDecl::client_id)
                    .map(str::to_owned),
            },
            action,
            risk_approved,
            force_refresh,
            session_id,
            &oauth_configuration(cfg)?,
        )
        .await;
    }
    let token = crate::mcp_oauth::global()
        .access_token(
            owner_user_id,
            profile_id,
            plugin_id,
            server_name,
            resource,
            cfg.auth
                .as_ref()
                .and_then(crate::plugin_manifest::McpServerAuthDecl::client_id),
            action,
            risk_approved,
            force_refresh,
            session_id,
        )
        .await?;
    if let McpTarget::Http(endpoint) | McpTarget::Sse(endpoint) = &mut target {
        endpoint
            .headers
            .insert("Authorization".to_owned(), format!("Bearer {token}"));
    }
    Ok(target)
}

pub(super) fn oauth_configuration(
    cfg: &McpServerConfig,
) -> Result<ryu_vault::mcp_transport::McpConfiguration> {
    use ryu_vault::mcp_transport::{McpConfiguration, TransportMode};
    let (transport, endpoint) = match cfg.to_target()? {
        McpTarget::Http(endpoint) => (TransportMode::StreamableHttp, endpoint),
        McpTarget::Sse(endpoint) => (TransportMode::Sse, endpoint),
        _ => bail!("MCP OAuth requires an HTTP transport"),
    };
    Ok(McpConfiguration {
        transport,
        static_headers: endpoint.headers,
    })
}

pub(super) async fn oauth_elicitation(
    cfg: &McpServerConfig,
    owner_user_id: &str,
    profile_id: &str,
    challenge: Option<String>,
) -> Result<Value> {
    if let Some(envelope) =
        crate::mcp_oauth::hosted_connect_elicitation(cfg.owner_server_name.as_deref())
    {
        return Ok(envelope);
    }
    let access_level = if crate::mcp_oauth::remote_configured() {
        let plugin = cfg
            .owner_plugin_id
            .as_deref()
            .context("OAuth MCP server has no owning plugin")?;
        let server = cfg
            .owner_server_name
            .as_deref()
            .context("OAuth MCP server has no owning manifest key")?;
        crate::mcp_oauth::connections(owner_user_id, plugin)
            .await?
            .iter()
            .find(|record| record["profile_id"] == profile_id && record["server_name"] == server)
            .and_then(|record| record["access_level"].as_str())
            .map(crate::identity::ConnectionAccessLevel::from_str)
            .unwrap_or_default()
    } else {
        match crate::identity::global() {
            Some(store) => {
                store
                    .get_connection_access_level(
                        owner_user_id,
                        crate::connection_policy::MCP_PROVIDER,
                        &crate::connection_policy::mcp_connection_key(
                            profile_id,
                            cfg.owner_plugin_id
                                .as_deref()
                                .context("OAuth MCP server has no owning plugin")?,
                            cfg.owner_server_name
                                .as_deref()
                                .context("OAuth MCP server has no owning manifest key")?,
                        ),
                    )
                    .await?
            }
            None => crate::identity::ConnectionAccessLevel::default(),
        }
    };
    let started = crate::mcp_oauth::global()
        .start_connect(crate::mcp_oauth::ConnectSpec {
            owner_user_id: owner_user_id.to_owned(),
            profile_id: profile_id.to_owned(),
            plugin_id: cfg
                .owner_plugin_id
                .clone()
                .context("OAuth MCP server has no owning plugin")?,
            server_name: cfg
                .owner_server_name
                .clone()
                .context("OAuth MCP server has no owning manifest key")?,
            resource_url: cfg
                .url
                .clone()
                .context("OAuth MCP server has no resource URL")?,
            auth: cfg
                .auth
                .clone()
                .context("OAuth MCP server has no auth declaration")?,
            callback_mode: crate::mcp_oauth::CallbackMode::Auto,
            static_headers: cfg.headers.clone(),
            access_level,
            challenge,
        })
        .await?;
    Ok(crate::identity::to_envelope(
        &crate::tool_exec::Elicitation {
            kind: "url".to_owned(),
            message: format!(
                "Connect {} before using this MCP server, then retry.",
                cfg.owner_server_name.as_deref().unwrap_or("the account")
            ),
            url: Some(started.authorization_url),
            requested_schema: None,
        },
    ))
}

#[cfg(test)]
#[path = "tests/oauth_dispatch.rs"]
mod tests;
