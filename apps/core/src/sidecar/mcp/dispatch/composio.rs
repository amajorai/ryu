//! The built-in Composio provider arm.

use super::Dispatch;
use crate::sidecar::mcp::*;

impl McpRegistry {
    // Built-in Composio provider (#474): searchable-not-listed, executed by
    // id prefix. Detected before split because the allowlist guard is
    // id-only (no bare name/server fallback).
    pub(super) async fn dispatch_composio(&self, call: Dispatch<'_>) -> Result<Value> {
        let Dispatch {
            agent_id,
            tool_id,
            arguments,
            allowlist,
            user_id,
            session_id,
            host_conversation_id,
            composio_connection_scope,
            account_policy,
            connection_action,
            ..
        } = call;
        if let Some(list) = allowlist {
            if !list.iter().any(|e| canonical_tool_id(e) == tool_id) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        let slug = tool_id.strip_prefix("composio.").unwrap_or(tool_id);
        let principal =
            ToolPrincipal::resolve_optional(self.conversations.as_ref(), host_conversation_id)
                .await;
        let (owner, composio_entity, verified_owner) = match principal {
            ToolPrincipal::Unrestricted => ("local".to_owned(), user_id.map(str::to_owned), None),
            ToolPrincipal::Owned { user_id, .. } => {
                (user_id.clone(), Some(user_id.clone()), Some(user_id))
            }
            ToolPrincipal::Unresolved => {
                return Err(anyhow!(
                    "a verified user identity is required for Composio on a shared node"
                ));
            }
        };
        // Who the Gateway authorizes and bills, fixed before routing: an
        // action routed to the agent's own entity is still the owner's
        // usage, recorded against this agent as `agent_id`.
        let charge_user = composio::charge_user_id(verified_owner.as_deref(), user_id);
        let access_level = if let Some(store) = crate::identity::global() {
            store
                .get_connection_access_level(
                    &owner,
                    crate::connection_policy::COMPOSIO_PROVIDER,
                    &crate::connection_policy::composio_connection_key(
                        crate::connection_policy::composio_toolkit_for_action(tool_id)
                            .as_deref()
                            .unwrap_or("unknown"),
                    ),
                )
                .await?
        } else {
            crate::identity::ConnectionAccessLevel::default()
        };
        if !access_level.allows_with_approval(connection_action, agent_id.is_some()) {
            return Err(anyhow!(crate::connection_policy::denied_message(
                "Composio",
                &crate::connection_policy::composio_toolkit_for_action(tool_id)
                    .unwrap_or_else(|| "unknown".to_owned()),
                access_level,
                connection_action,
            )));
        }
        // A restricted agent's policy only ever narrows a scope that a
        // server-owned caller (profile bootstrap, public agents, approvals)
        // already set; it never widens one.
        let restricted_policy = account_policy
            .as_ref()
            .filter(|policy| !policy.is_unrestricted());
        let narrowed_scope = restricted_policy
            .zip(composio_connection_scope)
            .map(|(policy, scope)| policy.narrow_composio_scope(scope));
        let composio_connection_scope = narrowed_scope.as_deref().or(composio_connection_scope);
        let mut composio_subject = ryu_composio::connect::Subject::User(composio_entity.as_deref());
        let selected_connection_id = match (composio_connection_scope, restricted_policy) {
            (Some(scope), _) => {
                let toolkit = crate::connection_policy::composio_toolkit_for_action(tool_id)
                    .ok_or_else(|| anyhow!("Composio action '{tool_id}' has no toolkit"))?;
                Some(
                    scope
                        .iter()
                        .find(|binding| binding.toolkit.eq_ignore_ascii_case(&toolkit))
                        .map(|binding| binding.id.clone())
                        .ok_or_else(|| {
                            anyhow!(
                                "Composio action '{tool_id}' is outside the selected source scope"
                            )
                        })?,
                )
            }
            (None, None) => None,
            // No scope was set, so derive one from the agent's own policy.
            // This is the only point every plane reaches (the Gateway tool
            // loop never forwards a scope), so it is where it is enforced.
            (None, Some(policy)) => {
                let agent_id = agent_id
                    .ok_or_else(|| anyhow!("Composio account policy needs a calling agent"))?;
                let toolkit = crate::connection_policy::composio_toolkit_for_action(tool_id)
                    .ok_or_else(|| anyhow!("Composio action '{tool_id}' has no toolkit"))?;
                let user_accounts = if policy.needs_user_composio_accounts() {
                    let listed = crate::composio_connect::list_connections(
                        &self.http,
                        &toolkit,
                        composio_entity.as_deref(),
                    )
                    .await
                    .map_err(|error| {
                        anyhow!(
                            "this agent's allowed Composio accounts could not be checked: {error}"
                        )
                    })?;
                    crate::agent_access::active_composio_bindings(&listed)
                        .into_iter()
                        .filter(|binding| binding.toolkit.eq_ignore_ascii_case(&toolkit))
                        .collect()
                } else {
                    Vec::new()
                };
                // Embedded mode lists the agent's own entity; the Connect
                // service lists the agent's account inside the owner's
                // tenant (and refuses a tenant without agent accounts).
                // A tenant whose Connect binding has no agent accounts refuses the
                // listing; that is "no own accounts", not a failure, so an allowed
                // user account still routes. Only when nothing else routes is the
                // refusal reported.
                let mut own_accounts_unsupported = None;
                let own_accounts = if policy.needs_own_composio_accounts() {
                    match crate::composio_connect::list_connections_for(
                        &self.http,
                        &toolkit,
                        ryu_composio::connect::Subject::Agent {
                            owner: &owner,
                            agent_id,
                        },
                    )
                    .await
                    {
                        Ok(listed) => crate::agent_access::active_composio_bindings(&listed)
                            .into_iter()
                            .filter(|binding| binding.toolkit.eq_ignore_ascii_case(&toolkit))
                            .collect(),
                        Err(error) if ryu_composio::service::is_subject_unsupported(&error) => {
                            own_accounts_unsupported = Some(error);
                            Vec::new()
                        }
                        Err(error) => {
                            return Err(anyhow!(
                                "this agent's own Composio accounts could not be checked: {error}"
                            ));
                        }
                    }
                } else {
                    Vec::new()
                };
                match policy.route_composio(&owner, agent_id, &user_accounts, &own_accounts) {
                    crate::agent_access::ComposioRoute::User {
                        connected_account_id,
                    } => connected_account_id,
                    crate::agent_access::ComposioRoute::Agent {
                        entity,
                        connected_account_id,
                    } => {
                        // The agent's own entity carries its own access
                        // ceiling, set when the user connected the app for
                        // it. It narrows the user's ceiling checked above;
                        // it never widens it.
                        let entity_level = if let Some(store) = crate::identity::global() {
                            store
                                .get_connection_access_level(
                                    &entity,
                                    crate::connection_policy::COMPOSIO_PROVIDER,
                                    &crate::connection_policy::composio_connection_key(&toolkit),
                                )
                                .await?
                        } else {
                            crate::identity::ConnectionAccessLevel::default()
                        };
                        if !entity_level.allows_with_approval(connection_action, true) {
                            return Err(anyhow!(crate::connection_policy::denied_message(
                                "Composio",
                                &toolkit,
                                entity_level,
                                connection_action,
                            )));
                        }
                        composio_subject = ryu_composio::connect::Subject::Agent {
                            owner: &owner,
                            agent_id,
                        };
                        connected_account_id
                    }
                    crate::agent_access::ComposioRoute::Denied => {
                        if let Some(error) = own_accounts_unsupported {
                            return Err(anyhow!(
                                "this agent's own Composio accounts could not be checked: {error}"
                            ));
                        }
                        return Err(anyhow!(
                            "Composio action '{tool_id}' needs a {toolkit} account this agent is not allowed to use"
                        ));
                    }
                }
            }
        };
        // A public-data action with a reviewed Treg equivalent runs there
        // when the flag is on (billed by Gateway); everything
        // else, and anything Gateway refuses before running, stays on
        // Composio. Checked after the principal and access policy above.
        let charge_session = session_id
            .clone()
            .or_else(|| host_conversation_id.map(str::to_owned));
        let mut result = match composio_treg_route::try_route(
            &self.http,
            slug,
            &arguments,
            selected_connection_id.is_some(),
            composio_treg_route::CallIdentity {
                agent_id,
                // The verified billing user, never an agent's own entity.
                user_id: charge_user.as_deref(),
                session_id: charge_session.as_deref(),
            },
        )
        .await
        {
            Ok(routed) => Ok(routed),
            Err(Err(error)) => Err(error),
            Err(Ok(skip)) => {
                if !matches!(
                    skip,
                    composio_treg_route::Skip::FlagOff | composio_treg_route::Skip::NotMapped
                ) {
                    tracing::debug!(?skip, slug, "composio action kept on composio");
                }
                composio::dispatch_with_connection(
                    &self.http,
                    slug,
                    arguments,
                    composio_subject,
                    selected_connection_id.as_deref(),
                    charge_user.as_deref(),
                )
                .await
            }
        };
        // The HTTP Gateway tool loop (`call_mcp_tool`) strips the receipt and
        // records its own call's charge, and marks that dispatch with
        // `CALLER_RECORDS_COMPOSIO_CHARGE`. Every other caller (native ACP
        // sessions, approval replay, workflows, aliases) is charged here, so
        // the receipt never leaks into a stored result.
        // Elicitation is a connection prompt, not an executed action; a
        // failure Composio logged is charged and still returned as a failure.
        let caller_records_charge = CALLER_RECORDS_COMPOSIO_CHARGE
            .try_with(|records| *records)
            .unwrap_or(false);
        let charge = if caller_records_charge {
            None
        } else {
            composio::take_tool_charge(&mut result)
        };
        if let Some(charge) = charge {
            let http = self.http.clone();
            let agent_id = agent_id.map(str::to_owned);
            let session_id = session_id
                .clone()
                .or_else(|| host_conversation_id.map(str::to_owned));
            tokio::spawn(async move {
                if let Err(error) = crate::sidecar::gateway::record_tool_charge(
                    &http,
                    agent_id.as_deref(),
                    charge_user.as_deref(),
                    session_id.as_deref(),
                    1,
                    charge.receipt.as_ref(),
                    charge.accounting_unavailable,
                )
                .await
                {
                    tracing::warn!(error = %error, "Composio charge notification failed");
                }
            });
        }
        result
    }
}

#[cfg(test)]
#[path = "../tests/dispatch_composio.rs"]
mod tests;
