//! Access tokens: refresh under the binding lock and sealed consumption.

use super::*;

impl McpOAuthManager {
    /// Resolve and proactively refresh the exact OAuth binding. The returned
    /// access token is for immediate header injection only.
    pub async fn access_token(
        &self,
        owner_user_id: &str,
        profile_id: &str,
        plugin_id: &str,
        server_name: &str,
        expected_resource: &str,
        expected_client_id: Option<&str>,
        action: crate::ConnectionAction,
        risk_approved: bool,
        force_refresh: bool,
        _session_id: Option<String>,
    ) -> Result<String> {
        let binding = BindingKey::new(owner_user_id, profile_id, plugin_id, server_name);
        let plugin_lock = self.plugin_lock(plugin_id).await;
        let _plugin_guard = plugin_lock.read().await;
        let lifecycle_lock = self.lifecycle_lock(&binding).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        self.access_token_locked(
            owner_user_id,
            profile_id,
            plugin_id,
            server_name,
            expected_resource,
            expected_client_id,
            action,
            risk_approved,
            force_refresh,
            None,
        )
        .await
    }

    pub(super) async fn access_token_locked(
        &self,
        owner_user_id: &str,
        profile_id: &str,
        plugin_id: &str,
        server_name: &str,
        expected_resource: &str,
        expected_client_id: Option<&str>,
        action: crate::ConnectionAction,
        risk_approved: bool,
        force_refresh: bool,
        _session_id: Option<String>,
    ) -> Result<String> {
        let store = &self.store;
        let connection = store
            .find_mcp_oauth_connection(owner_user_id, profile_id, plugin_id, server_name)
            .await?
            .context("MCP authentication required")?;
        if connection.status != McpOAuthConnectionStatus::Connected {
            bail!("MCP authentication required");
        }
        let access_level = store
            .get_connection_access_level(
                owner_user_id,
                "mcp",
                &connection_key(profile_id, plugin_id, server_name),
            )
            .await?;
        if !access_level.allows_with_approval(action, risk_approved) {
            bail!("{}", "MCP connection access level denied this action");
        }
        let stored_bundle = open_bundle(store, &connection).await?;
        let binding_changed = stored_bundle.mcp_server_url.is_empty()
            || stored_bundle.resource != connection.resource_uri
            || stored_bundle.issuer != connection.issuer
            || validate_oauth_url(&stored_bundle.mcp_server_url, true)?
                != validate_oauth_url(expected_resource, true)?
            || stored_bundle.declared_client_id.as_deref() != expected_client_id;
        if binding_changed {
            store.mark_mcp_oauth_reauth_required(&connection.id).await?;
            bail!("the MCP OAuth binding changed; reconnect required");
        }
        let recently_refreshed = self
            .refreshed
            .lock()
            .await
            .get(&BindingKey::new(
                owner_user_id,
                profile_id,
                plugin_id,
                server_name,
            ))
            .is_some_and(|at| at.elapsed() < Duration::from_secs(5));
        let refresh_needed = (force_refresh && !recently_refreshed)
            || connection.expires_at.is_some_and(|expires| {
                expires <= chrono::Utc::now().timestamp() + REFRESH_SKEW_SECS
            });
        if !refresh_needed {
            return Ok(stored_bundle.access_token);
        }
        let current = store
            .find_mcp_oauth_connection(owner_user_id, profile_id, plugin_id, server_name)
            .await?
            .context("MCP authentication required")?;
        if current.status != McpOAuthConnectionStatus::Connected {
            bail!("MCP authentication required");
        }
        let bundle = open_bundle(store, &current).await?;
        let binding_changed = bundle.mcp_server_url.is_empty()
            || validate_oauth_url(&bundle.mcp_server_url, true)?
                != validate_oauth_url(expected_resource, true)?
            || bundle.declared_client_id.as_deref() != expected_client_id;
        if binding_changed {
            store.mark_mcp_oauth_reauth_required(&current.id).await?;
            bail!("the MCP OAuth binding changed; reconnect required");
        }
        let another_caller_refreshed = current.updated_at != connection.updated_at;
        let current_is_fresh = current
            .expires_at
            .is_none_or(|expires| expires > chrono::Utc::now().timestamp() + REFRESH_SKEW_SECS);
        if another_caller_refreshed || (!force_refresh && current_is_fresh) {
            return Ok(bundle.access_token);
        }
        let refresh_token = bundle
            .refresh_token
            .clone()
            .context("MCP connection expired and has no refresh token")?;
        let mut form = vec![
            ("grant_type", "refresh_token".to_owned()),
            ("refresh_token", refresh_token),
            ("client_id", bundle.client_id.clone()),
            ("resource", bundle.resource.clone()),
        ];
        if let Some(secret) = &bundle.client_secret {
            form.push(("client_secret", secret.clone()));
        }
        let response = post_token_form(&bundle.token_endpoint, &form).await?;
        if response.error.as_deref() == Some("invalid_grant") {
            store.mark_mcp_oauth_reauth_required(&current.id).await?;
            bail!("MCP authentication expired; reconnect required");
        }
        if let Some(error) = response.error {
            bail!(
                "OAuth refresh failed: {}",
                sanitize_oauth_error_code(&error)
            );
        }
        if response.access_token.is_empty() {
            bail!("OAuth refresh returned no access token");
        }
        if !response
            .token_type
            .as_deref()
            .unwrap_or("Bearer")
            .eq_ignore_ascii_case("bearer")
        {
            bail!("OAuth refresh returned a non-Bearer token");
        }
        let updated = TokenBundle {
            access_token: response.access_token,
            refresh_token: response.refresh_token.or(bundle.refresh_token),
            id_token: response.id_token.or(bundle.id_token),
            token_type: response.token_type.unwrap_or_else(|| "Bearer".to_owned()),
            ..bundle
        };
        let expires_at = response
            .expires_in
            .map(|seconds| chrono::Utc::now().timestamp() + seconds.max(0));
        let scopes = response
            .scope
            .as_deref()
            .map(split_scopes)
            .unwrap_or(current.scopes);
        store
            .upsert_mcp_oauth_connection(
                owner_user_id,
                profile_id,
                plugin_id,
                server_name,
                &updated.resource,
                &updated.issuer,
                current.account_label.as_deref(),
                &scopes,
                expires_at,
                &SecretState::new(serde_json::to_string(&updated)?),
            )
            .await?;
        self.refreshed.lock().await.insert(
            BindingKey::new(owner_user_id, profile_id, plugin_id, server_name),
            std::time::Instant::now(),
        );
        Ok(updated.access_token)
    }

    /// Consume the exact binding while holding its lifecycle lock through egress.
    /// The request cannot supply an alternate resource, Authorization or callback sink.
    pub async fn consume(
        &self,
        binding: &McpBinding,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        action: crate::ConnectionAction,
        risk_approved: bool,
        force_refresh: bool,
    ) -> Result<ryu_egress::GuardedResponse> {
        self.consume_configured(
            binding,
            headers,
            body,
            action,
            risk_approved,
            force_refresh,
            &crate::mcp_transport::McpConfiguration::default(),
            &mut None,
        )
        .await
    }

    pub async fn consume_configured(
        &self,
        binding: &McpBinding,
        headers: Vec<(String, String)>,
        body: Vec<u8>,
        action: crate::ConnectionAction,
        risk_approved: bool,
        force_refresh: bool,
        configuration: &crate::mcp_transport::McpConfiguration,
        legacy: &mut Option<crate::mcp_transport::LegacySession>,
    ) -> Result<ryu_egress::GuardedResponse> {
        let key = BindingKey::new(
            &binding.owner_user_id,
            &binding.profile_id,
            &binding.plugin_id,
            &binding.server_name,
        );
        let plugin_lock = self.plugin_lock(&binding.plugin_id).await;
        let _plugin_guard = plugin_lock.read().await;
        let lock = self.lifecycle_lock(&key).await;
        let _guard = lock.lock().await;
        let token = self
            .access_token_locked(
                &binding.owner_user_id,
                &binding.profile_id,
                &binding.plugin_id,
                &binding.server_name,
                &binding.resource_url,
                binding.client_id.as_deref(),
                action,
                risk_approved,
                force_refresh,
                None,
            )
            .await?;
        validate_mcp_transport_headers(&headers)?;
        let mut headers = headers;
        // Providers may echo credentials in errors or content. Never reflect custody material.
        let record = self
            .store
            .find_mcp_oauth_connection(
                &binding.owner_user_id,
                &binding.profile_id,
                &binding.plugin_id,
                &binding.server_name,
            )
            .await?
            .context("MCP authentication required")?;
        let bundle = open_bundle(&self.store, &record).await?;
        let static_headers = configuration.normalized_headers()?;
        let expected_headers_hash = crate::mcp_transport::McpConfiguration {
            static_headers: static_headers.clone(),
            ..Default::default()
        }
        .fingerprint()?;
        if bundle.static_headers_hash != expected_headers_hash {
            bail!("MCP static header binding changed; reconnect required");
        }
        headers.extend(static_headers.iter().map(|(k, v)| (k.clone(), v.clone())));
        headers.push(("authorization".into(), format!("Bearer {token}")));
        let mut response = match configuration.transport {
            crate::mcp_transport::TransportMode::StreamableHttp => {
                request("POST", &binding.resource_url, headers, Some(body)).await?
            }
            crate::mcp_transport::TransportMode::Sse => {
                let mut failure = None;
                if legacy.is_none() {
                    let mut get_headers: Vec<_> = static_headers
                        .iter()
                        .map(|(k, v)| (k.clone(), v.clone()))
                        .collect();
                    get_headers.push(("authorization".into(), format!("Bearer {token}")));
                    get_headers.push(("accept".into(), "text/event-stream".into()));
                    match crate::mcp_transport::LegacySession::connect(
                        &binding.resource_url,
                        get_headers,
                        vec![token.clone()],
                    )
                    .await
                    {
                        Ok(session) => *legacy = Some(session),
                        Err(error) => {
                            match error.downcast::<crate::mcp_transport::LegacyHttpFailure>() {
                                Ok(error) => failure = Some(error.0),
                                Err(error) => return Err(error),
                            }
                        }
                    }
                }
                match failure {
                    Some(response) => response,
                    None => {
                        legacy
                            .as_mut()
                            .context("MCP SSE session missing")?
                            .exchange(headers, body)
                            .await?
                    }
                }
            }
        };
        let mut secrets: Vec<&str> = [
            Some(token.as_str()),
            Some(bundle.access_token.as_str()),
            bundle.refresh_token.as_deref(),
            bundle.id_token.as_deref(),
            bundle.client_secret.as_deref(),
        ]
        .into_iter()
        .flatten()
        .filter(|s| !s.is_empty())
        .collect();
        secrets.extend(
            static_headers
                .values()
                .map(String::as_str)
                .filter(|v| !v.is_empty()),
        );
        if let Some(legacy) = legacy {
            secrets.extend(
                legacy
                    .redaction_values
                    .iter()
                    .map(String::as_str)
                    .filter(|v| !v.is_empty()),
            );
        }
        if secrets.iter().any(|secret| {
            let escaped = serde_json::to_string(secret).unwrap_or_default();
            let escaped = escaped.trim_matches('"');
            let found = [*secret, escaped]
                .into_iter()
                .filter(|s| !s.is_empty())
                .any(|pattern| {
                    response
                        .body
                        .windows(pattern.len())
                        .any(|v| v == pattern.as_bytes())
                        || response.headers.iter().any(|(_, v)| v.contains(pattern))
                });
            found
        }) {
            bail!("MCP upstream response contained credential material");
        }
        response.headers.retain(|(name, _)| {
            matches!(
                name.to_ascii_lowercase().as_str(),
                "content-type" | "mcp-session-id" | "mcp-protocol-version" | "www-authenticate"
            )
        });
        Ok(response)
    }
}
