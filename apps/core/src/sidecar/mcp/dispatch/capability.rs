//! Capability facade and provider-service arms.
// test-exempt: moved verbatim out of sidecar/mcp/mod.rs; covered by the McpRegistry tests under sidecar/mcp/tests/.

use super::Dispatch;
use crate::sidecar::mcp::*;

impl McpRegistry {
    // Capability tool facade (swappable layers): a stable verb id
    // (`web.search`, `browser.navigate`, `memory.store`, …) whose concrete
    // provider is whatever the user has selected for that capability. Resolved
    // per call — an override taken mid-session takes effect on the next call
    // with no re-registration — then forwarded to the provider's own tool.
    //
    // The allowlist is enforced HERE, on the stable verb id, which is the point:
    // an agent allowed `web.search` keeps that permission across a provider
    // swap. The inner call carries NO allowlist because the target is fixed by
    // the provider's manifest, not chosen by the caller — the same reasoning as
    // the app-tool alias arm below, and the facade grants no authority the
    // provider's own tool would not have granted on a direct call.
    pub(super) async fn dispatch_capability_facade(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            agent_id,
            tool_id,
            arguments,
            allowlist,
            user_id,
            profile_ids,
            session_id,
            host_conversation_id,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        // A machine verb of a conversation with a session Box runs on that
        // Box's own screen (design §7.4). `box_desktop` calls the Box
        // service directly and never re-enters this dispatch core, so the
        // conversation gate above is evaluated once per call.
        if let Some(routed) = box_desktop::route(
            self.conversations.as_ref(),
            host_conversation_id,
            tool_id,
            &arguments,
        )
        .await
        {
            return routed;
        }
        let Some(resolved) = self.resolve_capability_verb(tool_id).await else {
            // Either no provider is selected for the capability, or the selected
            // one does not serve this verb. Structured, not an Err, so the
            // agent's turn continues and it can pick another approach.
            let capability = capability_tools::verb_by_id(tool_id).map(|v| v.capability);
            return Ok(serde_json::json!({
                "ok": false,
                "available": false,
                "capability": capability,
                "error": format!(
                    "no provider is selected for '{}' that serves '{tool_id}' — install and \
                     select one in the layer picker",
                    capability.unwrap_or("this capability")
                ),
            }));
        };
        let target = resolved.binding.tool.clone();
        // Never let a provider point a verb back at the facade (a manifest-driven
        // infinite loop), never at an empty target, and never at a Core tool.
        if target.is_empty()
            || capability_tools::verb_by_id(&target).is_some()
            || provider_target_guard::is_core_reserved_target(&target)
        {
            return Err(anyhow!(
                "provider '{}' maps '{tool_id}' to an invalid target '{target}'",
                resolved.provider_id
            ));
        }
        // Nor at a tool another plugin or the user owns (`gmail.send_email`).
        self.provider_target_ownership(&resolved.provider_id, &target)
            .await
            .map_err(|reason| anyhow!(reason))?;
        // The user's per-layer argument defaults ("web search returns 25
        // results", "crawl at most 50 pages"), merged UNDER the caller's own
        // arguments. Read here rather than cached with the verb resolution
        // because preferences change through the generic preferences API, which
        // knows nothing about layers and so cannot invalidate a cache.
        let layer_defaults = self.layer_defaults(resolved.verb).await;
        let arguments = capability_tools::apply_layer_defaults(&layer_defaults, arguments);
        // Resolve any `pref:` tokens the provider declared in its `arg_defaults`
        // — per-install configuration that is not a canonical verb argument
        // (Mem0's entity id, for instance). Without this a manifest could only
        // hard-code such a value, giving every install the same fixed bucket.
        let provider_defaults = self.resolve_provider_defaults(&resolved.binding).await;
        // A provider whose shape the declarative fields cannot bridge ships an
        // ADAPTER instead: JS that receives the canonical arguments and returns
        // the canonical result, calling its own bound tool through `callTool`.
        // It REPLACES the declarative mapping for this verb (arg rename/template/
        // clamp and the response map are that same job, done in JSON), so the
        // canonical arguments go in untouched and the returned value comes out
        // untouched. Everything the adapter can reach — one fixed tool, no
        // `host.*`, deny-all sandbox — is a subset of the declarative path's
        // authority, so this widens the trust surface only by the code itself,
        // which is why it is gated on `tool:execute`.
        if let Some(adapter) = resolved.binding.adapter.as_ref() {
            return CAPABILITY_PROVIDER_DISPATCH
                .scope(
                    true,
                    Box::pin(self.run_capability_adapter(
                        tool_id,
                        &resolved,
                        adapter,
                        provider_defaults,
                        arguments,
                        agent_id,
                        user_id,
                        profile_ids,
                        session_id.clone(),
                        host_conversation_id,
                    )),
                )
                .await;
        }
        let mapped = capability_tools::map_args_with_defaults(
            &resolved.binding,
            provider_defaults,
            arguments,
        );
        // `profile_ids` and `session_id` are threaded through, unlike the alias
        // arm which drops both. They matter here: a provider tool is typically a
        // declarative `http` tool whose `secret_headers` may resolve an Identity
        // Vault credential, and `run_http_tool` reads the caller's bound profiles
        // to do that. Dropping them would silently downgrade a vault-backed
        // provider to anonymous — a swap-visible behaviour difference, which is
        // exactly what this facade exists to prevent.
        let raw = CAPABILITY_PROVIDER_DISPATCH
            .scope(
                true,
                Box::pin(self.call_tool_with_identity_no_gate(
                    // Same calling agent, for the same reason `profile_ids` is
                    // threaded: the facade must not be a way to lose per-agent
                    // context that a direct call to the provider's tool kept.
                    agent_id,
                    &target,
                    mapped,
                    None,
                    user_id,
                    profile_ids,
                    session_id.clone(),
                    host_conversation_id,
                )),
            )
            .await?;
        Ok(capability_tools::map_response(
            &resolved.binding,
            &resolved.provider_id,
            raw,
        ))
    }

    // Built-in provider-usage reader. Core resolves the active subscription
    // account or BYOK key inside the usage tool; only the normalized result
    // returns to the agent.
    pub(super) async fn dispatch_usage_tool(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            tool_id,
            arguments,
            allowlist,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        usage_tool::dispatch(tool, arguments).await
    }

    // Built-in Treg tools. Only listed and callable with the flag on; the
    // metered call runs in Gateway, never with a Treg credential in Core.
    pub(super) async fn dispatch_treg_tool(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            tool_id,
            arguments,
            allowlist,
            account_policy,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        // The metered `call` runs on the org wallet, so it follows the
        // agent's Treg switch; `describe` is a free public catalog read.
        if tool == "call" {
            if let Some(policy) = account_policy.as_ref() {
                policy
                    .authorize_managed_provider_call("treg", None)
                    .map_err(|reason| anyhow!(reason))?;
            }
        }
        treg_tool::dispatch(&self.http, tool, arguments).await
    }

    // Built-in Ryu Challenges. The session bearer is read from Core's sealed
    // account store inside the module; `challenges.submit` only reaches this
    // point after the approval gate (see `approvals::policy`).
    pub(super) async fn dispatch_challenges_tool(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            tool_id,
            arguments,
            allowlist,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        challenges_tool::dispatch(tool, arguments).await
    }

    // Built-in Marketplace discovery. Anonymous public-catalog reads only; the
    // tool never forwards the user's buyer token and never installs.
    pub(super) async fn dispatch_marketplace_tool(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            tool_id,
            arguments,
            allowlist,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        marketplace_tool::dispatch(tool, arguments).await
    }

    // Built-in authenticated web-fetch provider (Identity Vault consumer):
    // fetches a page over HTTPS, injecting the user's sealed session for the
    // URL's domain (resolved by the consult above) server-side. The credential
    // is passed out-of-band — never through `arguments`, never to the model.
    pub(super) async fn dispatch_web_fetch(
        &self,
        call: Dispatch<'_>,
        server: &str,
        tool: &str,
    ) -> Result<Value> {
        let Dispatch {
            tool_id,
            arguments,
            allowlist,
            injected_credential,
            ..
        } = call;
        if let Some(list) = allowlist {
            let candidate = RegistryTool::candidate(tool_id, server, tool);
            if !tool_allowed(&candidate, list) {
                return Err(anyhow!("tool '{tool_id}' is not in this agent's allowlist"));
            }
        }
        let authenticated = injected_credential.is_some();
        let fetched = web_fetch::dispatch(tool, arguments, injected_credential).await;
        // A fetch made with the user's sealed session returns their logged-in
        // page: a connected-account read. An anonymous fetch is not a source.
        if authenticated && fetched.is_ok() {
            note_authenticated_read(tool_id);
        }
        fetched
    }
}
