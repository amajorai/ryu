//! Core authorization adapter. Remote errors never allow local credential fallback.
use crate::plugin_manifest::McpServerAuthDecl;
use anyhow::{bail, Context, Result};
use ryu_vault::mcp_oauth as broker;
use std::sync::{Arc, OnceLock};
use url::Url;
const LOCAL_OWNER: &str = "local";
const DEFAULT_PROFILE: &str = "personal";

pub use broker::{CallbackMode, ConnectStarted, FlowErrorCode, FlowState, FlowView};

#[derive(Debug, Clone)]
pub struct ConnectSpec {
    pub access_level: crate::identity::ConnectionAccessLevel,
    pub owner_user_id: String,
    pub profile_id: String,
    pub plugin_id: String,
    pub server_name: String,
    pub resource_url: String,
    pub auth: McpServerAuthDecl,
    pub callback_mode: CallbackMode,
    pub static_headers: std::collections::BTreeMap<String, String>,
    /// A runtime `insufficient_scope` challenge. REST-initiated connects leave
    /// this unset and Core probes the protected resource itself.
    pub challenge: Option<String>,
}

/// Principal used by OAuth REST handlers. A personal node has one stable local
/// owner. A shared node never accepts an unresolved user identity.
pub fn owner_for_caller(caller: Option<&crate::identity_verify::VerifiedCaller>) -> Result<String> {
    if let Some(caller) = caller {
        return Ok(caller.user_id.clone());
    }
    if crate::sidecar::control_plane::is_managed_node()
        || crate::sidecar::control_plane::registered_org().is_some()
    {
        bail!("a verified user identity is required for MCP OAuth on a shared node");
    }
    Ok(LOCAL_OWNER.to_owned())
}

pub fn default_profile_id() -> &'static str {
    DEFAULT_PROFILE
}

fn hosted_callback_url() -> Option<String> {
    let base = crate::sidecar::control_plane::node_public_url()?;
    let mut url = Url::parse(&base).ok()?;
    if url.scheme() != "https" || url.username() != "" || url.password().is_some() {
        return None;
    }
    url.set_path("/api/mcp/oauth/callback");
    url.set_query(None);
    url.set_fragment(None);
    Some(url.into())
}

pub fn hosted_client_metadata_url() -> Option<String> {
    let callback = hosted_callback_url()?;
    let mut url = Url::parse(&callback).ok()?;
    url.set_path("/api/mcp/oauth/client-metadata.json");
    Some(url.into())
}

pub fn hosted_redirect_uri() -> Option<String> {
    hosted_callback_url()
}

/// A tool call that needs an account on a hosted node (or in Passport remote
/// mode) does not start a flow itself. A hosted flow is saved only when the
/// person who started it enters the code the browser shows, which a sign-in
/// link pasted into the model's transcript can never lead to; that link could
/// also be opened by someone else. The model is told to have the user connect
/// from the Connections card or the chat's connect card instead.
pub fn hosted_connect_elicitation(server_name: Option<&str>) -> Option<serde_json::Value> {
    (remote_configured() || hosted_redirect_uri().is_some())
        .then(|| hosted_connect_envelope(server_name))
}

fn hosted_connect_envelope(server_name: Option<&str>) -> serde_json::Value {
    crate::identity::to_envelope(&crate::tool_exec::Elicitation {
        kind: "confirm".to_owned(),
        message: format!(
            "Ask the user to connect {} from Marketplace > Connections or the chat's connect card, then retry.",
            server_name.unwrap_or("the account")
        ),
        url: None,
        requested_schema: None,
    })
}

pub struct McpOAuthManager;
static MANAGER: McpOAuthManager = McpOAuthManager;
static EMBEDDED: OnceLock<Arc<broker::McpOAuthManager>> = OnceLock::new();
pub fn global() -> &'static McpOAuthManager {
    &MANAGER
}
pub fn remote_configured() -> bool {
    std::env::var_os("RYU_PASSPORT_URL").is_some()
}
fn embedded() -> Result<&'static Arc<broker::McpOAuthManager>> {
    if remote_configured() {
        bail!("Passport remote mode forbids local OAuth credential access");
    }
    let store = crate::identity::global().context("identity store not initialized")?;
    Ok(EMBEDDED.get_or_init(|| {
        broker::McpOAuthManager::new(
            store.clone(),
            hosted_redirect_uri(),
            hosted_client_metadata_url(),
        )
    }))
}
pub async fn remote<T: serde::de::DeserializeOwned>(
    operation: &str,
    body: serde_json::Value,
) -> Result<T> {
    let (status, value) =
        crate::identity::passport::manage(reqwest::Method::POST, &["mcp", operation], Some(body))
            .await
            .context("Passport remote mode is not configured")??;
    if !(200..300).contains(&status) {
        bail!("Passport MCP operation denied or unavailable (HTTP {status})");
    }
    serde_json::from_value(value).context("invalid Passport MCP metadata")
}
impl McpOAuthManager {
    pub async fn start_connect(&'static self, spec: ConnectSpec) -> Result<ConnectStarted> {
        let spec = broker::ConnectSpec {
            access_level: spec.access_level,
            owner_user_id: spec.owner_user_id,
            profile_id: spec.profile_id,
            plugin_id: spec.plugin_id,
            server_name: spec.server_name,
            resource_url: spec.resource_url,
            auth: broker::OAuthClient {
                client_id: spec.auth.client_id().map(str::to_owned),
            },
            callback_mode: spec.callback_mode,
            static_headers: spec.static_headers,
            challenge: spec.challenge,
        };
        if remote_configured() {
            return remote("connect", serde_json::to_value(spec)?).await;
        }
        embedded()?.start_connect(spec).await
    }
    pub async fn flow(&self, owner_user_id: &str, flow_id: &str) -> Result<FlowView> {
        if remote_configured() {
            return remote(
                "flow",
                serde_json::json!({"ownerUserId":owner_user_id,"flowId":flow_id}),
            )
            .await;
        }
        embedded()?.flow(owner_user_id, flow_id).await
    }
    pub async fn complete_hosted_callback(
        &self,
        code: Option<String>,
        returned_state: Option<String>,
        returned_issuer: Option<String>,
        oauth_error: Option<String>,
    ) -> Result<String> {
        if remote_configured() {
            let value: serde_json::Value = remote("callback", serde_json::json!({"code":code,"state":returned_state,"iss":returned_issuer,"error":oauth_error})).await?;
            return value
                .get("confirmationCode")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .context("Passport returned no OAuth confirmation code");
        }
        embedded()?
            .complete_hosted_callback(code, returned_state, returned_issuer, oauth_error)
            .await
    }
    /// Commit a hosted flow for the owner who started it, with the code its
    /// callback page showed.
    pub async fn confirm_hosted_flow(
        &self,
        owner_user_id: &str,
        flow_id: &str,
        code: &str,
    ) -> Result<()> {
        if remote_configured() {
            let _: serde_json::Value = remote(
                "confirm",
                serde_json::json!({"ownerUserId":owner_user_id,"flowId":flow_id,"code":code}),
            )
            .await?;
            return Ok(());
        }
        embedded()?
            .confirm_hosted_flow(owner_user_id, flow_id, code)
            .await
    }
    pub async fn access_token(
        &self,
        owner_user_id: &str,
        profile_id: &str,
        plugin_id: &str,
        server_name: &str,
        expected_resource: &str,
        expected_client_id: Option<&str>,
        action: crate::identity::ConnectionAction,
        risk_approved: bool,
        force_refresh: bool,
        session_id: Option<String>,
    ) -> Result<String> {
        let manager = embedded()?;
        use crate::sidecar::gateway::{
            check_identity_grant, report_credential_read_audit, IdentityGrantOutcome,
        };
        match check_identity_grant("identity.read", plugin_id).await {
            IdentityGrantOutcome::Allow => {}
            IdentityGrantOutcome::Deny(reason) => {
                bail!("identity read denied for MCP OAuth: {reason}")
            }
        }
        let token = manager
            .access_token(
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
            .await?;
        report_credential_read_audit("mcp-oauth", expected_resource, session_id, None).await;
        Ok(token)
    }
    pub async fn disconnect(
        &self,
        owner_user_id: &str,
        profile_id: &str,
        plugin_id: &str,
        server_name: &str,
    ) -> Result<(bool, bool)> {
        if remote_configured() {
            return remote("disconnect",serde_json::json!({"ownerUserId":owner_user_id,"profileId":profile_id,"pluginId":plugin_id,"serverName":server_name})).await;
        }
        embedded()?
            .disconnect(owner_user_id, profile_id, plugin_id, server_name)
            .await
    }
    pub async fn disconnect_plugin(&self, plugin_id: &str) -> Result<Vec<String>> {
        if remote_configured() {
            return remote(
                "disconnect-plugin",
                serde_json::json!({"pluginId":plugin_id}),
            )
            .await;
        }
        embedded()?.disconnect_plugin(plugin_id).await
    }
}
pub async fn connections(owner: &str, plugin: &str) -> Result<Vec<serde_json::Value>> {
    if remote_configured() {
        return remote(
            "connections",
            serde_json::json!({"ownerUserId":owner,"pluginId":plugin}),
        )
        .await;
    }
    let store = embedded()?.store();
    let mut result = Vec::new();
    for connection in store.list_mcp_oauth_connections(owner, plugin).await? {
        let level = store
            .get_connection_access_level(
                owner,
                "mcp",
                &broker::connection_key(&connection.profile_id, plugin, &connection.server_name),
            )
            .await?;
        let mut value = serde_json::to_value(connection)?;
        value["access_level"] = serde_json::json!(level);
        result.push(value);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_hosted_connect_prompt_carries_no_sign_in_link() {
        let envelope = super::hosted_connect_envelope(Some("mail"));
        let inner = &envelope["__ryu_elicitation__"];
        assert_eq!(inner["kind"], "confirm");
        assert!(inner.get("url").is_none(), "{envelope}");
        assert!(inner["message"]
            .as_str()
            .unwrap()
            .contains("connect mail from Marketplace > Connections"));
    }
}
