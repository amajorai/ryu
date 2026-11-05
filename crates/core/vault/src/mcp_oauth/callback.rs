//! Completing, failing and expiring a pending OAuth flow.

use super::*;

impl McpOAuthManager {
    pub async fn flow(&self, owner_user_id: &str, flow_id: &str) -> Result<FlowView> {
        let flows = self.flows.read().await;
        let flow = flows.get(flow_id).context("OAuth flow not found")?;
        if flow.owner_user_id != owner_user_id {
            bail!("OAuth flow not found");
        }
        Ok(flow.view.clone())
    }

    /// Complete the public hosted callback by its one-time OAuth state. The state
    /// is high entropy, expires with the flow, and is cleared after first use.
    pub async fn callback_binding(&self, state: &str) -> Result<McpBinding> {
        let flows = self.flows.read().await;
        let flow = flows
            .values()
            .find(|flow| {
                flow.view.callback_mode == CallbackMode::Hosted
                    && flow.view.status == FlowState::Pending
                    && !flow.callback_claimed
                    && flow.view.expires_at > chrono::Utc::now().timestamp()
                    && flow.state == state
            })
            .context(INVALID_STATE_MESSAGE)?;
        Ok(McpBinding {
            owner_user_id: flow.owner_user_id.clone(),
            profile_id: flow.view.profile_id.clone(),
            plugin_id: flow.view.plugin_id.clone(),
            server_name: flow.view.server_name.clone(),
            resource_url: flow.mcp_server_url.clone(),
            client_id: flow.declared_client_id.clone(),
        })
    }

    /// Exchange a hosted callback's code and hold the tokens for the owner to
    /// confirm. Returns the one-time code the callback page must show; nothing
    /// is stored until [`Self::confirm_hosted_flow`] receives it.
    pub async fn complete_hosted_callback(
        self: &Arc<Self>,
        code: Option<String>,
        returned_state: Option<String>,
        returned_issuer: Option<String>,
        oauth_error: Option<String>,
    ) -> Result<String> {
        let state = returned_state.as_deref().context(STATE_OMITTED_MESSAGE)?;
        let flow_id = self
            .flows
            .read()
            .await
            .iter()
            .find(|(_, flow)| {
                flow.view.callback_mode == CallbackMode::Hosted
                    && flow.view.status == FlowState::Pending
                    && !flow.callback_claimed
                    && flow.state == state
            })
            .map(|(flow_id, _)| flow_id.clone())
            .context(INVALID_STATE_MESSAGE)?;
        self.complete_callback(&flow_id, code, returned_state, returned_issuer, oauth_error)
            .await?
            .context("hosted OAuth callback produced no confirmation code")
    }

    /// Complete a callback. A loopback flow (bound to its per-flow listener)
    /// connects at once and returns `None`; a hosted flow is held and returns
    /// its confirmation code.
    pub(super) async fn complete_callback(
        self: &Arc<Self>,
        flow_id: &str,
        code: Option<String>,
        returned_state: Option<String>,
        returned_issuer: Option<String>,
        oauth_error: Option<String>,
    ) -> Result<Option<String>> {
        let pending = self
            .claim_callback(flow_id, returned_state.as_deref())
            .await?;
        let completion = self
            .complete_claimed_callback(flow_id, pending, code, returned_issuer, oauth_error)
            .await;
        if let Err(error) = &completion {
            self.mark_flow_failed(flow_id, &error.to_string()).await;
        }
        completion
    }

    pub(super) async fn complete_claimed_callback(
        self: &Arc<Self>,
        flow_id: &str,
        pending: PendingFlow,
        code: Option<String>,
        returned_issuer: Option<String>,
        oauth_error: Option<String>,
    ) -> Result<Option<String>> {
        if chrono::Utc::now().timestamp() >= pending.view.expires_at {
            bail!(EXPIRED_MESSAGE);
        }
        if let Some(error) = oauth_error {
            bail!(
                "authorization failed: {}",
                sanitize_oauth_error_code(&error)
            );
        }
        // RFC 9207 mix-up defence. The hosted callback is one URL shared by every
        // authorization server, and the server selected for this flow sees the
        // state, so only the returned `iss` proves the response came from it. Its
        // own metadata cannot waive that (a malicious server would simply not
        // advertise support). The loopback listener is a fresh port per flow, so
        // there the redirect itself binds the response and an issuerless reply
        // stays acceptable unless the server promised to send `iss`.
        if let Some(returned_issuer) = returned_issuer.as_deref() {
            if trim_trailing_slash(returned_issuer) != trim_trailing_slash(&pending.issuer) {
                bail!(ISSUER_MISMATCH_MESSAGE);
            }
        } else if pending.view.callback_mode == CallbackMode::Hosted {
            bail!(HOSTED_ISSUER_MISSING_MESSAGE);
        } else if pending.require_issuer_parameter {
            bail!(ISSUER_MISSING_MESSAGE);
        }
        let code = code.context(MISSING_CODE_MESSAGE)?;
        let mut form = vec![
            ("grant_type", "authorization_code".to_owned()),
            ("code", code),
            ("redirect_uri", pending.redirect_uri.clone()),
            ("client_id", pending.client_id.clone()),
            ("code_verifier", pending.verifier.clone()),
            ("resource", pending.resource.clone()),
        ];
        if let Some(secret) = &pending.client_secret {
            form.push(("client_secret", secret.clone()));
        }
        let response = post_token_form(&pending.token_endpoint, &form).await?;
        if let Some(error) = response.error {
            bail!(
                "token exchange failed: {}",
                sanitize_oauth_error_code(&error)
            );
        }
        if !response
            .token_type
            .as_deref()
            .unwrap_or("Bearer")
            .eq_ignore_ascii_case("bearer")
        {
            bail!("token endpoint returned a non-Bearer token");
        }
        if response.access_token.is_empty() {
            bail!("token endpoint returned no access token");
        }
        let expires_at = response
            .expires_in
            .map(|seconds| chrono::Utc::now().timestamp() + seconds.max(0));
        let scopes = response
            .scope
            .as_deref()
            .map(split_scopes)
            .unwrap_or_else(|| pending.view.scopes.clone());
        let binding = BindingKey::from_flow(&pending);
        let bundle = TokenBundle {
            static_headers_hash: pending.static_headers_hash,
            access_token: response.access_token,
            refresh_token: response.refresh_token,
            id_token: response.id_token,
            token_type: "Bearer".to_owned(),
            client_id: pending.client_id,
            client_secret: pending.client_secret,
            token_endpoint: pending.token_endpoint,
            revocation_endpoint: pending.revocation_endpoint,
            issuer: pending.issuer.clone(),
            resource: pending.resource.clone(),
            mcp_server_url: pending.mcp_server_url,
            declared_client_id: pending.declared_client_id,
        };
        let plaintext = serde_json::to_string(&bundle).context("serializing OAuth token bundle")?;
        let material = confirm::ConnectionMaterial {
            plaintext,
            scopes,
            expires_at,
        };
        if pending.view.callback_mode == CallbackMode::Hosted {
            return self
                .hold_for_confirmation(flow_id, &binding, material)
                .await
                .map(Some);
        }
        self.commit_connection(flow_id, &binding, FlowState::Pending, Some(material))
            .await
            .map(|()| None)
    }

    pub(super) async fn claim_callback(
        &self,
        flow_id: &str,
        returned_state: Option<&str>,
    ) -> Result<PendingFlow> {
        let mut flows = self.flows.write().await;
        let flow = flows.get_mut(flow_id).context("OAuth flow not found")?;
        if flow.callback_claimed {
            bail!(CALLBACK_USED_MESSAGE);
        }
        if returned_state != Some(flow.state.as_str()) {
            bail!(STATE_MISMATCH_MESSAGE);
        }
        flow.callback_claimed = true;
        Ok(flow.clone())
    }

    pub(super) async fn fail_flow(&self, flow_id: &str, message: &str) -> Result<()> {
        self.mark_flow_failed(flow_id, message).await;
        bail!(message.to_owned())
    }

    pub(super) async fn mark_flow_failed(&self, flow_id: &str, message: &str) {
        if let Some(flow) = self.flows.write().await.get_mut(flow_id) {
            if matches!(
                flow.view.status,
                FlowState::Pending | FlowState::AwaitingConfirmation
            ) {
                flow.view.status = FlowState::Failed;
                flow.view.error = Some(message.to_owned());
                flow.view.error_code = Some(FlowErrorCode::classify(message));
                flow.held = None;
                scrub_flow_secrets(flow);
            }
        }
    }

    pub(super) async fn expire_flow(&self, flow_id: &str) {
        let Some(binding) = self
            .flows
            .read()
            .await
            .get(flow_id)
            .map(BindingKey::from_flow)
        else {
            return;
        };
        let plugin_lock = self.plugin_lock(&binding.plugin_id).await;
        let _plugin_guard = plugin_lock.read().await;
        let lifecycle_lock = self.lifecycle_lock(&binding).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let mut unconfirmed = None;
        if let Some(flow) = self.flows.write().await.get_mut(flow_id) {
            let now = chrono::Utc::now().timestamp();
            // A held flow's deadline moves when the callback arrives, so only
            // fail it once that later deadline has passed.
            let expired = match flow.view.status {
                FlowState::Pending => true,
                FlowState::AwaitingConfirmation => now >= flow.view.expires_at,
                FlowState::Connected | FlowState::Failed => false,
            };
            if expired {
                flow.view.status = FlowState::Failed;
                flow.view.error = Some(EXPIRED_MESSAGE.to_owned());
                flow.view.error_code = Some(FlowErrorCode::Expired);
                unconfirmed = flow.held.take();
                scrub_flow_secrets(flow);
            }
        }
        if let Some(held) = unconfirmed {
            confirm::revoke_unconfirmed(held).await;
        }
    }
}
