//! Disconnecting one binding or every binding of an uninstalled plugin.

use super::*;

impl McpOAuthManager {
    pub async fn disconnect(
        &self,
        owner_user_id: &str,
        profile_id: &str,
        plugin_id: &str,
        server_name: &str,
    ) -> Result<(bool, bool)> {
        let binding = BindingKey::new(owner_user_id, profile_id, plugin_id, server_name);
        let plugin_lock = self.plugin_lock(plugin_id).await;
        let _plugin_guard = plugin_lock.read().await;
        self.disconnect_binding(&binding).await
    }

    pub(super) async fn disconnect_binding(&self, binding: &BindingKey) -> Result<(bool, bool)> {
        let lifecycle_lock = self.lifecycle_lock(binding).await;
        let _lifecycle_guard = lifecycle_lock.lock().await;
        self.refreshed.lock().await.remove(binding);
        self.flows.write().await.retain(|_, flow| {
            !(flow.owner_user_id == binding.owner_user_id
                && flow.view.profile_id == binding.profile_id
                && flow.view.plugin_id == binding.plugin_id
                && flow.view.server_name == binding.server_name)
        });
        let store = &self.store;
        let Some(connection) = store
            .find_mcp_oauth_connection(
                &binding.owner_user_id,
                &binding.profile_id,
                &binding.plugin_id,
                &binding.server_name,
            )
            .await?
        else {
            return Ok((false, false));
        };
        let mut revocation_confirmed = false;
        if let Ok(bundle) = open_bundle(store, &connection).await {
            if let Some(endpoint) = &bundle.revocation_endpoint {
                let token = bundle
                    .refresh_token
                    .as_deref()
                    .unwrap_or(&bundle.access_token)
                    .to_owned();
                let mut form = vec![("token", token), ("client_id", bundle.client_id.clone())];
                if let Some(secret) = &bundle.client_secret {
                    form.push(("client_secret", secret.clone()));
                }
                revocation_confirmed = post_form_empty(endpoint, &form).await.is_ok();
            }
        }
        let deleted = store
            .delete_mcp_oauth_connection(
                &binding.owner_user_id,
                &binding.profile_id,
                &binding.plugin_id,
                &binding.server_name,
            )
            .await?;
        Ok((deleted, revocation_confirmed))
    }

    /// Lifecycle cleanup for uninstall. Every owner/profile row belonging to the
    /// plugin is removed even when an upstream revocation endpoint is unavailable.
    /// The return value names bindings whose remote revocation was not confirmed.
    pub async fn disconnect_plugin(&self, plugin_id: &str) -> Result<Vec<String>> {
        let plugin_lock = self.plugin_lock(plugin_id).await;
        let _plugin_guard = plugin_lock.write().await;
        let store = &self.store;
        let connections = store
            .list_mcp_oauth_connections_for_plugin(plugin_id)
            .await?;
        let connection_bindings: HashSet<BindingKey> = connections
            .iter()
            .map(BindingKey::from_connection)
            .collect();
        let mut bindings = connection_bindings.clone();
        bindings.extend(
            self.flows
                .read()
                .await
                .values()
                .filter(|flow| flow.view.plugin_id == plugin_id)
                .map(BindingKey::from_flow),
        );
        let mut unconfirmed = Vec::new();
        let mut failures = Vec::new();
        for binding in bindings {
            match self.disconnect_binding(&binding).await {
                Ok((_, true)) => {}
                Ok((_, false)) if connection_bindings.contains(&binding) => {
                    unconfirmed.push(binding.label());
                }
                Ok((_, false)) => {}
                Err(error) => failures.push(format!("{}: {error:#}", binding.label())),
            }
        }
        self.flows
            .write()
            .await
            .retain(|_, flow| flow.view.plugin_id != plugin_id);
        unconfirmed.sort();
        failures.sort();
        if !failures.is_empty() {
            bail!(
                "failed to clean up one or more MCP OAuth bindings after attempting all of them: {}",
                failures.join("; ")
            );
        }
        Ok(unconfirmed)
    }
}
