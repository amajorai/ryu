use reqwest::Client;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tracing::{debug, info, warn};

use crate::config::ComposioConfig;
use crate::error::GatewayError;
use crate::providers::Provider;

/// Default Composio REST base (v3.1, current as of 2026-06). The old `/api/v1`
/// is gone; v3.1 executes tools at `/tools/execute/{tool_slug}`. Swappable via
/// `COMPOSIO_BASE_URL` so a future surface change is one env, not a rebuild
/// (kept in sync with `apps/core/src/composio_catalog`).
const DEFAULT_COMPOSIO_BASE_URL: &str = "https://backend.composio.dev/api/v3.1";

fn composio_base_url() -> String {
    std::env::var("COMPOSIO_BASE_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .map(|s| s.trim_end_matches('/').to_string())
        .unwrap_or_else(|| DEFAULT_COMPOSIO_BASE_URL.to_string())
}

/// A Composio user namespace derived only from Gateway-authenticated org state.
/// The hash keeps raw organization ids out of the provider's user-id namespace.
pub struct ComposioTenantScope {
    prefix: String,
}

impl ComposioTenantScope {
    pub fn new(org_id: &str) -> Result<Self, GatewayError> {
        if org_id.trim().is_empty() {
            return Err(GatewayError::Unauthorized(
                "Composio requires an authenticated organization".to_owned(),
            ));
        }
        Ok(Self {
            prefix: format!(
                "ryu_org_v1_{}_",
                hex::encode(Sha256::digest(org_id.as_bytes()))
            ),
        })
    }

    pub fn default_user_id(&self) -> String {
        format!("{}default", self.prefix)
    }

    pub fn user_id(&self, user_id: &str) -> String {
        format!(
            "{}user_{}",
            self.prefix,
            hex::encode(Sha256::digest(user_id.as_bytes()))
        )
    }

    pub fn account_user_id(&self, account_id: &str) -> Result<String, GatewayError> {
        if account_id.trim().is_empty() || account_id.len() > 256 {
            return Err(GatewayError::BadRequest(
                "invalid Composio account identity".to_owned(),
            ));
        }
        Ok(format!(
            "{}account_{}",
            self.prefix,
            hex::encode(Sha256::digest(account_id.as_bytes()))
        ))
    }

    pub fn entity_for_user(&self, user_id: Option<&str>) -> String {
        user_id
            .filter(|value| !value.trim().is_empty())
            .map_or_else(|| self.default_user_id(), |value| self.user_id(value))
    }

    /// Whether `user_id` is a Composio entity this caller may act through.
    ///
    /// The org-shared entity and app-account entities (`account_`) belong to
    /// the organization. A member's personal entity (`user_`) belongs to that
    /// member alone: it is accepted only when it is the authenticated caller's
    /// own entity, so naming another member's connected-account id never lets
    /// an org-level caller act through that member's account.
    fn owns_user_id(&self, user_id: &str, caller_user_id: Option<&str>) -> bool {
        if user_id == self.default_user_id() {
            return true;
        }
        if let Some(caller) = caller_user_id.filter(|value| !value.trim().is_empty()) {
            if user_id == self.user_id(caller) {
                return true;
            }
        }
        user_id
            .strip_prefix(&format!("{}account_", self.prefix))
            .is_some_and(|hash| {
                hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
            })
    }
}

fn valid_connection_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 256
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// A Composio action slug is the last segment of the key-bearing
/// `/tools/execute/{slug}` URL. Only ASCII alphanumerics, `_` and `-` may reach
/// it: a `/`, `..`, `%`, `?` or `#` could move the request to another action or
/// API path than the one the caller named.
fn valid_action_slug(slug: &str) -> bool {
    !slug.is_empty()
        && slug.len() <= 256
        && slug
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
}

/// Largest file a caller may declare for one staged upload slot.
pub const FILE_UPLOAD_MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;

/// A validated `file_upload` operation: which tool the file belongs to and the
/// facts Composio needs to stage it. Every field is checked here so a malformed
/// app request never reaches the provider.
struct FileUploadRequest {
    toolkit_slug: String,
    tool_slug: String,
    filename: String,
    mimetype: String,
    md5: String,
    /// The caller's declared size. Composio's slot request carries no size, so
    /// this is not forwarded; it bounds what a caller may ask to stage.
    size: u64,
}

impl FileUploadRequest {
    const MAX_UPLOAD_BYTES: u64 = FILE_UPLOAD_MAX_BYTES;
    const MAX_FILENAME_CHARS: usize = 255;
    const MAX_MIMETYPE_BYTES: usize = 127;
    const MAX_SLUG_BYTES: usize = 128;

    fn parse(tool_slug: &str, file: &Value) -> Result<Self, GatewayError> {
        let bad = |why: &str| GatewayError::BadRequest(format!("invalid file upload: {why}"));
        let tool_slug = tool_slug.trim();
        if tool_slug.is_empty()
            || tool_slug.len() > Self::MAX_SLUG_BYTES
            || !tool_slug
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return Err(bad("tool slug must be letters, digits and underscores"));
        }
        let field = |name: &str| file.get(name).and_then(Value::as_str).map(str::trim);
        let toolkit_slug = field("toolkitSlug")
            .filter(|slug| {
                !slug.is_empty()
                    && slug.len() <= Self::MAX_SLUG_BYTES
                    && slug
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
            })
            .ok_or_else(|| bad("toolkitSlug is missing or malformed"))?;
        let filename = field("filename")
            .filter(|name| {
                !name.is_empty()
                    && name.chars().count() <= Self::MAX_FILENAME_CHARS
                    && !name.contains(['/', '\\'])
                    && !name.chars().any(char::is_control)
            })
            .ok_or_else(|| bad("filename is missing, too long or contains a path"))?;
        let mimetype = field("mimetype")
            .filter(|mime| {
                mime.len() <= Self::MAX_MIMETYPE_BYTES
                    && mime.split_once('/').is_some_and(|(kind, sub)| {
                        let token = |part: &str| {
                            !part.is_empty()
                                && part.bytes().all(|byte| {
                                    byte.is_ascii_alphanumeric()
                                        || matches!(byte, b'.' | b'+' | b'-' | b'_')
                                })
                        };
                        token(kind) && token(sub)
                    })
            })
            .ok_or_else(|| bad("mimetype must look like type/subtype"))?;
        let md5 = field("md5")
            .filter(|digest| digest.len() == 32 && digest.bytes().all(|b| b.is_ascii_hexdigit()))
            .ok_or_else(|| bad("md5 must be 32 hex characters"))?;
        let size = file
            .get("size")
            .and_then(Value::as_u64)
            .filter(|size| *size > 0)
            .ok_or_else(|| bad("size must be a positive byte count"))?;
        if size > Self::MAX_UPLOAD_BYTES {
            return Err(bad(&format!(
                "size {size} exceeds the {} byte staging limit",
                Self::MAX_UPLOAD_BYTES
            )));
        }
        Ok(Self {
            toolkit_slug: toolkit_slug.to_ascii_lowercase(),
            tool_slug: tool_slug.to_owned(),
            filename: filename.to_owned(),
            mimetype: mimetype.to_ascii_lowercase(),
            md5: md5.to_ascii_lowercase(),
            size,
        })
    }
}

/// Reduce Composio's upload-request response to the slot a caller needs. The
/// presigned URL must be HTTPS: a plain-HTTP write target would expose the
/// media in transit, so it is refused rather than passed on.
fn file_upload_slot(response: &Value) -> Result<Value, GatewayError> {
    let key = response
        .get("key")
        .and_then(Value::as_str)
        .filter(|key| !key.trim().is_empty())
        .ok_or_else(|| {
            GatewayError::ProviderError("Composio file upload returned no storage key".to_owned())
        })?;
    let upload_url = response
        .get("new_presigned_url")
        .or_else(|| response.get("newPresignedUrl"))
        .and_then(Value::as_str)
        .ok_or_else(|| {
            GatewayError::ProviderError("Composio file upload returned no upload URL".to_owned())
        })?;
    let parsed = reqwest::Url::parse(upload_url).map_err(|_| {
        GatewayError::ProviderError("Composio file upload returned a malformed URL".to_owned())
    })?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err(GatewayError::ProviderError(
            "Composio file upload returned a non-HTTPS upload URL".to_owned(),
        ));
    }
    let storage_backend = response
        .pointer("/metadata/storage_backend")
        .and_then(Value::as_str)
        .unwrap_or("s3");
    Ok(json!({
        "key": key,
        "uploadUrl": upload_url,
        "storageBackend": storage_backend,
    }))
}

pub struct ComposioClient {
    http: Client,
    config: ComposioConfig,
    #[cfg(test)]
    test_base_url: Option<String>,
}

impl ComposioClient {
    pub fn new(config: ComposioConfig, http: Client) -> Self {
        Self {
            http,
            config,
            #[cfg(test)]
            test_base_url: None,
        }
    }

    #[cfg(test)]
    pub(crate) fn for_test(config: ComposioConfig, http: Client, base_url: String) -> Self {
        Self {
            http,
            config,
            test_base_url: Some(base_url),
        }
    }

    fn base_url(&self) -> String {
        #[cfg(test)]
        if let Some(base) = &self.test_base_url {
            return base.clone();
        }
        composio_base_url()
    }

    /// Return the list of allowlisted Composio action names.
    pub fn actions(&self) -> &[String] {
        &self.config.actions
    }

    /// An org-bound request must never select the shared single-user fallback.
    /// `user_id` here is the identity already accepted by Gateway authentication,
    /// not a raw request header.
    pub fn entity_for_request(
        &self,
        org_id: Option<&str>,
        user_id: Option<&str>,
    ) -> Result<String, GatewayError> {
        if let Some(org_id) = org_id {
            let tenant = ComposioTenantScope::new(org_id)?;
            return Ok(tenant.entity_for_user(user_id));
        }
        Ok(user_id
            .filter(|value| !value.trim().is_empty())
            .unwrap_or(self.config.entity_id.as_str())
            .to_owned())
    }

    /// Composio may accept a specific connected-account id independently of
    /// `user_id`. Check its provider-recorded owner before any tenant action:
    /// it must be org-shared, an app account, or the caller's own entity.
    pub async fn connection_user_for_tenant(
        &self,
        connection_id: &str,
        tenant: &ComposioTenantScope,
        caller_user_id: Option<&str>,
    ) -> Result<String, GatewayError> {
        if !valid_connection_id(connection_id) {
            return Err(GatewayError::BadRequest(
                "invalid Composio connected account id".to_owned(),
            ));
        }
        let value = self
            .request_json(
                reqwest::Method::GET,
                &format!("/connected_accounts/{connection_id}"),
                None,
            )
            .await?;
        let account = if value.get("id").is_some() {
            &value
        } else {
            value.get("data").unwrap_or(&value)
        };
        let user_id = account.get("user_id").and_then(Value::as_str);
        if account.get("id").and_then(Value::as_str) != Some(connection_id)
            || !user_id.is_some_and(|value| tenant.owns_user_id(value, caller_user_id))
        {
            return Err(GatewayError::PolicyViolation(
                "Composio account is unavailable for this organization".to_owned(),
            ));
        }
        Ok(user_id.expect("checked above").to_owned())
    }

    /// Inject allowlisted Composio actions as tool definitions into the
    /// request body so the model can emit `tool_call` turns for them.
    ///
    /// Each action is represented as a minimal OpenAI-compatible tool
    /// definition. Full JSON-Schema parameter schemas require a live fetch
    /// from `/actions/{name}` which is done lazily; the injected stub is
    /// sufficient for the model to choose the action and pass its own
    /// arguments — the gateway validates against the allowlist on execution.
    ///
    /// Only injects when `body["tools"]` is absent or empty so callers can
    /// provide their own tool definitions without being overwritten.
    ///
    /// `allowed` is the effective action allowlist for this request: the
    /// per-agent set Core forwarded (`x-ryu-composio-actions`) when present, else
    /// the gateway's global `config.actions` (#456). The execution check in
    /// [`run_tool_loop`] uses the same slice so injection and gating agree.
    pub fn inject_tools(&self, body: &mut Value, allowed: &[String]) {
        if allowed.is_empty() {
            return;
        }

        // Respect any tool list the caller already built.
        let already_has_tools = body["tools"]
            .as_array()
            .map(|a| !a.is_empty())
            .unwrap_or(false);
        if already_has_tools {
            return;
        }

        let tool_defs: Vec<Value> = allowed
            .iter()
            .map(|action_name| {
                json!({
                    "type": "function",
                    "function": {
                        "name": action_name,
                        "description": format!(
                            "Composio action '{}'. Pass the required parameters \
                             as JSON in the arguments field.",
                            action_name
                        ),
                        "parameters": {
                            "type": "object",
                            "properties": {
                                "arguments": {
                                    "type": "object",
                                    "description": "Action-specific parameters"
                                }
                            }
                        }
                    }
                })
            })
            .collect();

        debug!(
            count = tool_defs.len(),
            "injecting Composio tool definitions"
        );
        body["tools"] = json!(tool_defs);
    }

    /// Execute a single Composio action by name.
    ///
    /// The `entity_id` parameter selects the connected-account owner in
    /// Composio's entity model. Pass the caller's user-id (from the
    /// `x-ryu-user-id` header) when available; fall back to the configured
    /// default (`COMPOSIO_ENTITY_ID` env, or `"default"` for single-user
    /// setups).
    ///
    /// Returns the `data` field from the Composio response, or an error.
    pub async fn execute(
        &self,
        action_name: &str,
        input: Value,
        entity_id: &str,
    ) -> Result<Value, GatewayError> {
        self.execute_with_connection(action_name, input, entity_id, None)
            .await
    }

    /// Execute with an optional connected-account id selected by an app such as
    /// Outpost. The entity remains Gateway-owned; the connection id is only a
    /// provider operation argument and never a credential.
    pub async fn execute_with_connection(
        &self,
        action_name: &str,
        input: Value,
        entity_id: &str,
        connected_account_id: Option<&str>,
    ) -> Result<Value, GatewayError> {
        let mut response = self
            .execute_response(action_name, input, entity_id, connected_account_id, None)
            .await?;
        Ok(response["data"].take())
    }

    pub async fn execute_metered(
        &self,
        action_name: &str,
        input: Value,
        entity_id: &str,
        connected_account_id: Option<&str>,
    ) -> Result<(Value, u64, String), GatewayError> {
        self.execute_metered_within(action_name, input, entity_id, connected_account_id, None)
            .await
    }

    /// [`Self::execute_metered`] with a per-call upstream timeout in place of the
    /// client's default, for tools known to run long (a `file_uploadable` tool
    /// that pulls a staged file and pushes it to the platform). A timeout after
    /// the request was sent is [`GatewayError::ProviderDeliveryUncertain`]: the
    /// tool may still complete upstream, so callers must not blindly retry it.
    pub async fn execute_metered_within(
        &self,
        action_name: &str,
        input: Value,
        entity_id: &str,
        connected_account_id: Option<&str>,
        timeout: Option<std::time::Duration>,
    ) -> Result<(Value, u64, String), GatewayError> {
        let mut response = self
            .execute_response(action_name, input, entity_id, connected_account_id, timeout)
            .await?;
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .build()
            .map_err(|error| GatewayError::Internal(error.into()))?;
        // Bind the billing log to the identity this request selected: the
        // pinned account, or (when none was pinned) the Gateway-owned entity,
        // whose ownership of the logged account the receipt verifies.
        let expected = connected_account_id.map_or(
            ryu_composio::receipt::ExpectedExecutionIdentity::Entity(entity_id),
            ryu_composio::receipt::ExpectedExecutionIdentity::ConnectedAccount,
        );
        let receipt = ryu_composio::receipt::execution_receipt(
            &client,
            &self.base_url(),
            self.config.api_key.as_deref().unwrap_or(""),
            &response,
            expected,
        )
        .await
        .map_err(|_| GatewayError::AccountingUnavailable)?;
        let charge = ryu_gw_contracts::composio_billing::price_composio_usage(
            &receipt.usage,
            &self.config.billing,
            1,
        )
        .map_err(|_| GatewayError::AccountingUnavailable)?;
        Ok((
            response["data"].take(),
            charge.total_micro_usd,
            receipt.transaction_id,
        ))
    }

    async fn execute_response(
        &self,
        action_name: &str,
        input: Value,
        entity_id: &str,
        connected_account_id: Option<&str>,
        timeout: Option<std::time::Duration>,
    ) -> Result<Value, GatewayError> {
        if !valid_action_slug(action_name) {
            return Err(GatewayError::BadRequest(
                "Composio tool id must be a plain action slug".to_owned(),
            ));
        }
        let api_key =
            self.config.api_key.as_deref().ok_or_else(|| {
                GatewayError::Internal(anyhow::anyhow!("Composio API key not set"))
            })?;

        // v3.1: POST /tools/execute/{tool_slug} with { arguments, user_id }.
        let url = format!("{}/tools/execute/{action_name}", self.base_url());

        debug!(action = action_name, entity_id, "executing Composio action");

        let mut payload = json!({
            "arguments": input,
            "user_id": entity_id,
            "entity_id": entity_id,
        });
        if let Some(connection_id) = connected_account_id {
            payload["connected_account_id"] = Value::String(connection_id.to_owned());
        }
        let mut request = self
            .http
            .post(&url)
            .header("x-api-key", api_key)
            .header("Content-Type", "application/json")
            .json(&payload);
        if let Some(timeout) = timeout {
            request = request.timeout(timeout);
        }
        let resp = request.send().await.map_err(|error| {
            if error.is_timeout() {
                // The action may still be running upstream; say so rather than
                // reporting a failure the caller would retry.
                GatewayError::ProviderDeliveryUncertain(format!(
                    "Composio action {action_name} did not answer in time; its outcome is unknown"
                ))
            } else {
                GatewayError::Internal(error.into())
            }
        })?;

        if !resp.status().is_success() {
            let status = resp.status();
            // The error body is third-party integration data (may carry PII);
            // log only its size, never its content.
            let body = resp.text().await.unwrap_or_default();
            warn!(action = action_name, %status, body_len = body.len(), "Composio action failed");
            return Err(GatewayError::ProviderError(format!(
                "Composio action {action_name} failed: {status}"
            )));
        }

        let body: Value = resp
            .json()
            .await
            .map_err(|e| GatewayError::Internal(e.into()))?;

        Ok(body)
    }

    /// Read the managed Composio action catalog for one toolkit. The caller only
    /// receives catalog metadata; the API key stays in this Gateway process.
    pub async fn list_tools(&self, toolkit_slug: &str) -> Result<Value, GatewayError> {
        let api_key =
            self.config.api_key.as_deref().ok_or_else(|| {
                GatewayError::Internal(anyhow::anyhow!("Composio API key not set"))
            })?;
        let url = format!("{}/tools", self.base_url());
        let response = self
            .http
            .get(url)
            .header("x-api-key", api_key)
            .query(&[("toolkit_slug", toolkit_slug), ("limit", "200")])
            .send()
            .await
            .map_err(|error| GatewayError::Internal(error.into()))?;
        if !response.status().is_success() {
            return Err(GatewayError::ProviderError(format!(
                "Composio toolkit catalog failed: {}",
                response.status()
            )));
        }
        response
            .json()
            .await
            .map_err(|error| GatewayError::Internal(error.into()))
    }

    /// Start the managed Composio connection flow for one toolkit.
    pub async fn connect(&self, toolkit_slug: &str, user_id: &str) -> Result<Value, GatewayError> {
        self.request_json(
            reqwest::Method::POST,
            "/connected_accounts",
            Some(json!({ "toolkit": toolkit_slug, "userId": user_id })),
        )
        .await
    }

    /// Remove one managed Composio connection.
    pub async fn disconnect(&self, connection_id: &str) -> Result<Value, GatewayError> {
        if !valid_connection_id(connection_id) {
            return Err(GatewayError::BadRequest(
                "invalid Composio connected account id".to_owned(),
            ));
        }
        self.request_json(
            reqwest::Method::DELETE,
            &format!("/connected_accounts/{connection_id}"),
            None,
        )
        .await
    }

    /// Reserve a staged upload slot for one file a Composio tool will consume.
    ///
    /// Composio's file parameters (`file_uploadable` in its tool schemas) take
    /// `{ name, mimetype, s3key }`, where the key comes from
    /// `POST /files/upload/request` and the bytes go to the presigned URL it
    /// returns. Only this request needs the project key; the presigned URL is a
    /// short-lived, single-object write grant, so a caller can stream the bytes
    /// itself without ever holding the Composio credential.
    ///
    /// The returned value carries just the key, the upload URL and the storage
    /// backend, never the raw upstream envelope.
    pub async fn request_file_upload(
        &self,
        tool_slug: &str,
        file: &Value,
    ) -> Result<Value, GatewayError> {
        let request = FileUploadRequest::parse(tool_slug, file)?;
        debug!(
            tool = %request.tool_slug,
            declared_bytes = request.size,
            "requesting a Composio staged upload slot"
        );
        let response = self
            .request_json(
                reqwest::Method::POST,
                "/files/upload/request",
                Some(json!({
                    "toolkit_slug": request.toolkit_slug,
                    "tool_slug": request.tool_slug,
                    "filename": request.filename,
                    "mimetype": request.mimetype,
                    "md5": request.md5,
                })),
            )
            .await?;
        file_upload_slot(&response)
    }

    async fn request_json(
        &self,
        method: reqwest::Method,
        path: &str,
        body: Option<Value>,
    ) -> Result<Value, GatewayError> {
        let api_key =
            self.config.api_key.as_deref().ok_or_else(|| {
                GatewayError::Internal(anyhow::anyhow!("Composio API key not set"))
            })?;
        let url = format!("{}{path}", self.base_url());
        let mut request = self
            .http
            .request(method, url)
            .header("x-api-key", api_key)
            .header("Content-Type", "application/json");
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| GatewayError::Internal(error.into()))?;
        if !response.status().is_success() {
            return Err(GatewayError::ProviderError(format!(
                "Composio request failed: {}",
                response.status()
            )));
        }
        response
            .json()
            .await
            .map_err(|error| GatewayError::Internal(error.into()))
    }

    /// Run the agentic tool-call loop for a non-streaming request.
    ///
    /// After each provider completion, checks the response for `tool_calls`.
    /// Allowed calls use Core's governed dispatcher when it is configured;
    /// standalone Gateway executes its configured Composio actions directly.
    /// Results are appended
    /// as `tool` messages and the loop continues until no tool calls remain or
    /// `max_rounds` is reached.
    ///
    /// `entity_id` selects the connected account. Core's legacy `user_id` wire
    /// field carries this selector; Core resolves owner authority independently
    /// from its ToolPrincipal and refuses unresolved shared-node callers.
    /// `agent_id` comes from the authenticated request context. Callers prefer
    /// `RequestContext::user_id` and fall back to `ComposioConfig::entity_id`.
    ///
    /// Returns the final assistant turn and a zero compatibility counter.
    /// Core settles its own execution receipts;
    /// standalone executions settle through `on_charge`. The returned count is
    /// zero so the pipeline cannot debit either path a second time.
    pub async fn run_tool_loop_for_session(
        &self,
        body: &mut Value,
        provider: &dyn Provider,
        model: &str,
        entity_id: &str,
        allowed: &[String],
        catalog: Option<&dyn crate::tools::CoreCatalog>,
        agent_id: Option<&str>,
        session: Option<&str>,
        firewall: Option<&crate::tools::ToolLoopFirewall>,
        org_tools: &crate::policy::OrgToolGate,
        on_charge: &(dyn Fn(u64, &str) + Send + Sync),
    ) -> Result<(Value, u64), GatewayError> {
        // Inject action tool definitions before the first completion so the
        // model knows which actions are available (scoped to `allowed`, minus
        // anything the organization's tool policy denies).
        let offered: Vec<String> = allowed
            .iter()
            .filter(|action| {
                org_tools.permits(&format!(
                    "{}{}",
                    crate::tools::catalog_client::COMPOSIO_TOOL_PREFIX,
                    action
                ))
            })
            .cloned()
            .collect();
        self.inject_tools(body, &offered);

        let mut response = provider.complete_for_session(model, body, session).await?;

        for round in 0..self.config.max_rounds {
            let tool_calls = match response["choices"][0]["message"]["tool_calls"].as_array() {
                Some(tc) if !tc.is_empty() => tc.clone(),
                _ => break, // no tool calls — done
            };

            info!(round, count = tool_calls.len(), "Composio tool-call round");

            // Screen the model turn (its text and every action's arguments)
            // before any action runs or the turn is sent back to the provider.
            if let Some(firewall) = firewall {
                firewall.screen_appended(&response["choices"][0]["message"])?;
                firewall
                    .screen_hazard(
                        &response["choices"][0]["message"],
                        crate::tools::ToolRoundPart::ModelTurn,
                        round,
                    )
                    .await?;
                // A suspension pushed mid-loop stops it before any action runs.
                firewall.check_standing().await?;
            }

            // Append the assistant turn with the tool_calls.
            if let Some(msgs) = body["messages"].as_array_mut() {
                msgs.push(response["choices"][0]["message"].clone());
            }

            // Execute each tool call and inject results.
            for tc in &tool_calls {
                let name = tc["function"]["name"].as_str().unwrap_or("");
                let arguments = crate::tools::call_arguments(tc);
                let args_str: &str = &arguments;
                let tool_call_id = tc["id"].as_str().unwrap_or("");

                let input: Value = serde_json::from_str(args_str).unwrap_or(json!({}));

                let tool_span = crate::telemetry::gen_ai_span::execute_tool_span(
                    name,
                    tool_call_id,
                    "extension",
                );
                // Only a successful action RESULT is untrusted external content;
                // denials and error envelopes are Gateway-generated.
                let mut is_external_result = false;
                let tool_id = format!(
                    "{}{}",
                    crate::tools::catalog_client::COMPOSIO_TOOL_PREFIX,
                    name
                );
                let denied = firewall.and_then(|firewall| firewall.deny_call(&tool_id, args_str));
                let result = if !allowed.iter().any(|a| a == name) {
                    warn!(action = name, "Composio action not in allowlist; skipping");
                    json!({ "error": format!("action '{name}' not allowed") })
                } else if let Err(reason) = org_tools.check(&tool_id) {
                    // The organization's tool policy (C2) applies before both the
                    // Core catalog and the direct provider branch.
                    json!({ "error": reason })
                } else if let Some(reason) = denied {
                    warn!(action = name, %reason, "Composio action denied by the Gateway firewall");
                    json!({ "error": format!("action denied ({reason})") })
                } else if let Some(catalog) = catalog {
                    // Core owns the persisted connection ceiling, owner and
                    // approval checks, and the execution charge. A refusal or
                    // unreachable Core must never fall back to provider access.
                    match tracing::Instrument::instrument(
                        catalog.call_tool(
                            &format!(
                                "{}{}",
                                crate::tools::catalog_client::COMPOSIO_TOOL_PREFIX,
                                name
                            ),
                            input,
                            agent_id,
                            // This wire field is only an entity selector;
                            // it cannot supply Core's ToolPrincipal authority.
                            Some(entity_id),
                            None,
                            None,
                            false,
                        ),
                        tool_span.clone(),
                    )
                    .await
                    {
                        Ok(result) => {
                            is_external_result = true;
                            result
                        }
                        Err(error) => json!({ "error": error }),
                    }
                } else {
                    match tracing::Instrument::instrument(
                        self.execute_metered(name, input, entity_id, None),
                        tool_span.clone(),
                    )
                    .await
                    {
                        Ok((result, cost, transaction_id)) => {
                            // Settle each execution before a later model turn can
                            // fail. The provider log ID deduplicates wallet retries.
                            on_charge(cost, &transaction_id);
                            is_external_result = true;
                            result
                        }
                        Err(GatewayError::AccountingUnavailable) => {
                            return Err(GatewayError::AccountingUnavailable)
                        }
                        Err(e) => {
                            warn!(action = name, error = %e, "Composio action error; returning error result");
                            json!({ "error": e.to_string() })
                        }
                    }
                };
                crate::telemetry::gen_ai_span::record_tool_result(&tool_span, &result);
                drop(tool_span);

                // Screen the raw result before it is wrapped or redacted, so a
                // blocking match ends the loop instead of reaching the next round.
                if let Some(firewall) = firewall {
                    firewall.screen_appended(&result)?;
                    firewall
                        .screen_hazard(&result, crate::tools::ToolRoundPart::ToolResult, round)
                        .await?;
                }

                // Mail, documents and other action output is attacker-reachable
                // content: screen it with the request firewall and wrap it in
                // untrusted-content markers, exactly as the unified loop does.
                let content = if is_external_result {
                    crate::tools::external_tool_result_content(firewall, name, &result)
                } else {
                    result.to_string()
                };
                if let Some(msgs) = body["messages"].as_array_mut() {
                    msgs.push(json!({
                        "role": "tool",
                        "tool_call_id": tool_call_id,
                        "content": content,
                    }));
                }
            }

            // Follow-up completion with tool results injected.
            if let Some(firewall) = firewall {
                firewall.check_standing().await?;
            }
            response = provider.complete_for_session(model, body, session).await?;
        }

        // Per-execution receipts already settled the tools. The shared loop
        // interface's second value is zero, so callers cannot double-debit.
        Ok((response, 0))
    }
}

#[cfg(test)]
mod tenant_tests {
    use super::{valid_action_slug, valid_connection_id, ComposioClient, ComposioTenantScope};
    use crate::config::ComposioConfig;
    use crate::error::GatewayError;

    #[test]
    fn managed_orgs_get_distinct_users_and_local_calls_keep_the_configured_entity() {
        let config = ComposioConfig {
            entity_id: "local-user".to_owned(),
            ..Default::default()
        };
        let client = ComposioClient::for_test(
            config,
            reqwest::Client::new(),
            "http://unused.test".to_owned(),
        );
        let alpha = client.entity_for_request(Some("org-alpha"), None).unwrap();
        let beta = client.entity_for_request(Some("org-beta"), None).unwrap();
        assert_ne!(alpha, beta);
        assert_ne!(alpha, "local-user");
        assert_ne!(
            client
                .entity_for_request(Some("org-alpha"), Some("same-user"))
                .unwrap(),
            client
                .entity_for_request(Some("org-beta"), Some("same-user"))
                .unwrap()
        );
        assert_eq!(client.entity_for_request(None, None).unwrap(), "local-user");
        assert_eq!(
            client
                .entity_for_request(None, Some("local-member"))
                .unwrap(),
            "local-member"
        );

        let alpha_scope = ComposioTenantScope::new("org-alpha").unwrap();
        let account_user = alpha_scope.account_user_id("social-account-1").unwrap();
        assert!(alpha_scope.owns_user_id(&account_user, None));
        assert!(!ComposioTenantScope::new("org-beta")
            .unwrap()
            .owns_user_id(&account_user, None));
        assert!(!alpha_scope.owns_user_id("local-user", None));
        assert!(alpha_scope.owns_user_id(&alpha_scope.default_user_id(), None));

        // A member's personal entity is theirs alone.
        let member = alpha_scope.user_id("member-a");
        assert!(alpha_scope.owns_user_id(&member, Some("member-a")));
        assert!(!alpha_scope.owns_user_id(&member, Some("member-b")));
        assert!(!alpha_scope.owns_user_id(&member, None));
        assert!(valid_connection_id("ca_abc-123"));
        assert!(!valid_connection_id("ca_abc/../other"));
        assert!(!valid_connection_id("ca_abc?other=1"));
    }

    #[test]
    fn action_slugs_accept_plain_slugs_and_refuse_path_syntax() {
        assert!(valid_action_slug("GITHUB_CREATE_ISSUE"));
        assert!(valid_action_slug("gmail-send_email2"));
        for slug in [
            "",
            "GITHUB_X/../GMAIL_SEND_EMAIL",
            "GITHUB_X%2f..",
            "GITHUB_X?other=1",
            "GITHUB_X#frag",
            "GITHUB_X\\Y",
            "GITHUB X",
            "..",
        ] {
            assert!(!valid_action_slug(slug), "slug {slug:?} must be refused");
        }
        assert!(!valid_action_slug(&"A".repeat(257)));
    }

    #[tokio::test]
    async fn execute_and_disconnect_refuse_path_syntax_before_any_request() {
        // The base URL is unroutable, so a request that slipped past the check
        // would fail with a different error than `BadRequest`.
        let client = ComposioClient::for_test(
            ComposioConfig {
                api_key: Some("composio-project-test-key".to_owned()),
                ..Default::default()
            },
            reqwest::Client::new(),
            "http://unused.test".to_owned(),
        );
        let execute = client
            .execute_response(
                "GITHUB_X/../GMAIL_SEND_EMAIL",
                serde_json::json!({}),
                "entity",
                None,
                None,
            )
            .await;
        assert!(matches!(execute, Err(GatewayError::BadRequest(_))));
        let disconnect = client.disconnect("ca_abc/../x").await;
        assert!(matches!(disconnect, Err(GatewayError::BadRequest(_))));
    }
}

#[cfg(test)]
mod loop_policy_tests;
