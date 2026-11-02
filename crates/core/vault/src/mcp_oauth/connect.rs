//! Starting an OAuth connect: discovery, client registration and PKCE.

use super::*;

impl McpOAuthManager {
    pub async fn start_connect(self: &Arc<Self>, spec: ConnectSpec) -> Result<ConnectStarted> {
        let static_configuration = crate::mcp_transport::McpConfiguration {
            static_headers: spec.static_headers.clone(),
            ..Default::default()
        };
        let static_headers_hash = static_configuration.fingerprint()?;
        let binding = BindingKey::new(
            &spec.owner_user_id,
            &spec.profile_id,
            &spec.plugin_id,
            &spec.server_name,
        );
        let plugin_lock = self.plugin_lock(&binding.plugin_id).await;
        let _plugin_guard = plugin_lock.read().await;
        let lifecycle_lock = self.lifecycle_lock(&binding).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        let now = chrono::Utc::now().timestamp();
        {
            let mut flows = self.flows.write().await;
            flows.retain(|_, flow| flow.view.expires_at.saturating_add(FLOW_TTL_SECS) > now);
            if flows.len() >= 256 {
                bail!("OAuth flow capacity exceeded");
            }
        }
        if let Some(existing) = self.flows.read().await.values().find(|flow| {
            flow.owner_user_id == spec.owner_user_id
                && flow.view.profile_id == spec.profile_id
                && flow.view.plugin_id == spec.plugin_id
                && flow.view.server_name == spec.server_name
                && flow.view.status == FlowState::Pending
                && flow.view.expires_at > now
        }) {
            return Ok(ConnectStarted {
                access_level: existing.view.access_level.clone(),
                flow_id: existing.view.flow_id.clone(),
                authorization_url: existing.authorization_url.clone(),
                callback_mode: existing.view.callback_mode,
                scopes: existing.view.scopes.clone(),
                status: FlowState::Pending,
                expires_at: existing.view.expires_at,
            });
        }
        let resource_url = validate_oauth_url(&spec.resource_url, true)?;
        let challenge = match spec.challenge.clone() {
            Some(challenge) => Some(challenge),
            None => oauth_challenge(&resource_url, &spec.static_headers).await?,
        };
        let challenge_scopes = challenge
            .as_deref()
            .and_then(|value| bearer_parameter(value, "scope"))
            .as_deref()
            .map(|value| split_scopes(value))
            .unwrap_or_default();
        let metadata_url = challenge
            .as_deref()
            .and_then(|value| bearer_parameter(value, "resource_metadata"))
            .map(|value| resource_url.join(&value))
            .transpose()
            .context("invalid resource_metadata URL in WWW-Authenticate")?
            .unwrap_or_else(|| protected_resource_metadata_url(&resource_url));
        let resource_metadata: ProtectedResourceMetadata = get_json(metadata_url.as_str()).await?;
        let resource = resource_metadata
            .resource
            .clone()
            .unwrap_or_else(|| resource_url.as_str().to_owned());
        let resource_parsed = validate_oauth_url(&resource, true)?;
        if resource_parsed.origin() != resource_url.origin() {
            bail!("protected-resource metadata changed the MCP resource origin");
        }
        let issuer = resource_metadata
            .authorization_servers
            .first()
            .context("protected-resource metadata declares no authorization server")?;
        let issuer_url = validate_oauth_url(issuer, false)?;
        let metadata = discover_authorization_server(&issuer_url).await?;
        if trim_trailing_slash(&metadata.issuer) != trim_trailing_slash(issuer_url.as_str()) {
            bail!("authorization-server metadata issuer does not match the discovered issuer");
        }
        validate_server_metadata_endpoints(&issuer_url, &metadata)?;
        if !metadata.code_challenge_methods_supported.is_empty()
            && !metadata
                .code_challenge_methods_supported
                .iter()
                .any(|method| method == "S256")
        {
            bail!("authorization server does not support PKCE S256");
        }

        let hosted_redirect = self.hosted_redirect.clone();
        let callback_mode = match spec.callback_mode {
            CallbackMode::Auto if hosted_redirect.is_some() => CallbackMode::Hosted,
            CallbackMode::Auto => CallbackMode::Loopback,
            mode => mode,
        };
        // The shared hosted callback is only safe when every response carries the
        // RFC 9207 `iss` parameter (see `complete_claimed_callback`). Refuse a
        // server that does not advertise it now, before the consent round trip,
        // instead of failing the callback after the user has already approved.
        // The callback still enforces `iss`, so a server that advertises support
        // and then omits it is rejected there.
        if callback_mode == CallbackMode::Hosted
            && !metadata.authorization_response_iss_parameter_supported
        {
            bail!(
                "this MCP authorization server does not return the RFC 9207 `iss` parameter, \
                 which hosted nodes require; connect it from a local desktop app instead"
            );
        }
        let (redirect_uri, listener) = match callback_mode {
            CallbackMode::Hosted => (
                hosted_redirect
                    .context("hosted OAuth requires an HTTPS RYU_NODE_PUBLIC_URL for this node")?,
                None,
            ),
            CallbackMode::Loopback | CallbackMode::Auto => {
                let listener = TcpListener::bind("127.0.0.1:0")
                    .await
                    .context("binding the loopback OAuth callback")?;
                let callback_addr = listener.local_addr()?;
                (
                    format!("http://127.0.0.1:{}/oauth/callback", callback_addr.port()),
                    Some(listener),
                )
            }
        };

        let client_metadata_id = (callback_mode == CallbackMode::Hosted
            && metadata.client_id_metadata_document_supported)
            .then(|| self.hosted_client.clone())
            .flatten();
        let (client_id, client_secret) = match (client_metadata_id, spec.auth.client_id()) {
            (Some(client_id), _) => (client_id, None),
            (None, Some(client_id)) => (client_id.trim().to_owned(), None),
            (None, None) => {
                let registration_endpoint = metadata.registration_endpoint.as_deref().context(
                    "authorization server provides neither a pre-registered client id nor dynamic client registration",
                )?;
                register_dynamic_client(registration_endpoint, &redirect_uri).await?
            }
        };
        let verifier = random_urlsafe(32);
        let challenge_value = base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(Sha256::digest(verifier.as_bytes()));
        let state = random_urlsafe(32);
        let flow_id = format!("oauth_flow_{}", uuid::Uuid::new_v4().simple());
        let expires_at = now + FLOW_TTL_SECS;
        let requested_scopes = consent_scopes(
            challenge_scopes,
            &resource_metadata.scopes_supported,
            &metadata.scopes_supported,
        );
        let mut scopes: std::collections::BTreeSet<String> = requested_scopes.into_iter().collect();
        {
            let store = &self.store;
            if let Some(existing) = store
                .find_mcp_oauth_connection(
                    &spec.owner_user_id,
                    &spec.profile_id,
                    &spec.plugin_id,
                    &spec.server_name,
                )
                .await?
            {
                scopes.extend(existing.scopes);
            }
        }
        let scopes: Vec<String> = scopes.into_iter().collect();

        let mut authorization_url = validate_oauth_url(&metadata.authorization_endpoint, false)?;
        {
            let mut query = authorization_url.query_pairs_mut();
            query
                .append_pair("response_type", "code")
                .append_pair("client_id", &client_id)
                .append_pair("redirect_uri", &redirect_uri)
                .append_pair("code_challenge", &challenge_value)
                .append_pair("code_challenge_method", "S256")
                .append_pair("state", &state)
                .append_pair("resource", resource_parsed.as_str());
            if !scopes.is_empty() {
                query.append_pair("scope", &scopes.join(" "));
            }
        }
        let pending = PendingFlow {
            static_headers_hash,
            view: FlowView {
                access_level: spec.access_level.as_str().to_owned(),
                flow_id: flow_id.clone(),
                plugin_id: spec.plugin_id,
                server_name: spec.server_name,
                profile_id: spec.profile_id,
                callback_mode,
                scopes: scopes.clone(),
                status: FlowState::Pending,
                expires_at,
                error: None,
            },
            authorization_url: authorization_url.as_str().to_owned(),
            owner_user_id: spec.owner_user_id,
            resource: resource_parsed.as_str().to_owned(),
            mcp_server_url: resource_url.as_str().to_owned(),
            declared_client_id: spec.auth.client_id().map(str::to_owned),
            issuer: metadata.issuer,
            token_endpoint: metadata.token_endpoint,
            revocation_endpoint: metadata.revocation_endpoint,
            client_id,
            client_secret,
            redirect_uri,
            verifier,
            state,
            callback_claimed: false,
            require_issuer_parameter: metadata.authorization_response_iss_parameter_supported,
        };
        self.flows.write().await.insert(flow_id.clone(), pending);
        let expiry_flow_id = flow_id.clone();
        let manager = self.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_secs(FLOW_TTL_SECS as u64)).await;
            manager.expire_flow(&expiry_flow_id).await;
        });
        if let Some(listener) = listener {
            tokio::spawn(accept_loopback_callback(
                self.clone(),
                listener,
                flow_id.clone(),
            ));
        }

        Ok(ConnectStarted {
            access_level: spec.access_level.as_str().to_owned(),
            flow_id,
            authorization_url: authorization_url.into(),
            callback_mode,
            scopes,
            status: FlowState::Pending,
            expires_at,
        })
    }
}
