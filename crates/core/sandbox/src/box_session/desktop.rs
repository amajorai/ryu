//! Session Box verbs: desktop tokens and actions, browser calls, the session
//! credential, the tick-liveness keepalive, service features, and limits.

use super::*;

impl BoxSessionClient {
    /// Mint a single-use desktop stream token for one viewer. The returned
    /// `url` is kept only when it is absolute and carries no token; Core never
    /// forwards a relative or token-bearing URL.
    pub async fn mint_desktop_token(
        &self,
        id: &WorkspaceId,
        request: &DesktopTokenRequest,
    ) -> Result<DesktopToken, BoxApiError> {
        check_box_id(&id.0)?;
        if request.origin.trim().is_empty() || request.sub.trim().is_empty() {
            return Err(invalid_request(
                "a desktop token needs a viewer origin and subject",
            ));
        }
        let body = serde_json::to_value(request)
            .map_err(|error| invalid_request(format!("desktop token request: {error}")))?;
        let value = self
            .request(
                reqwest::Method::POST,
                &format!("/boxes/{}/access-tokens", id.0),
                Some(body),
                None,
                None,
            )
            .await?;
        parse_desktop_token(value)
    }

    /// Run one canonical desktop action (`screenshot`, `click`, `type`,
    /// `key`, `scroll`, `focus_app`) on the Box's own screen.
    pub async fn desktop_action(
        &self,
        id: &WorkspaceId,
        action: &Value,
    ) -> Result<Value, BoxApiError> {
        check_box_id(&id.0)?;
        let named = action
            .as_object()
            .and_then(|object| object.get("action"))
            .and_then(Value::as_str)
            .is_some_and(|name| !name.trim().is_empty());
        if !named {
            return Err(invalid_request(
                "a desktop action must be an object with an action name",
            ));
        }
        self.request(
            reqwest::Method::POST,
            &format!("/boxes/{}/desktop/actions", id.0),
            Some(action.clone()),
            None,
            Some(self.timeout.max(DESKTOP_CALL_TIMEOUT)),
        )
        .await
    }

    /// Call one browser verb (`navigate`, `tabs`, `snapshot`, `click`, …) on
    /// the Box's own browser.
    pub async fn browser_call(
        &self,
        id: &WorkspaceId,
        verb: &str,
        args: &Value,
    ) -> Result<Value, BoxApiError> {
        check_box_id(&id.0)?;
        check_browser_verb(verb)?;
        let body = match args {
            Value::Null => Value::Object(Map::new()),
            Value::Object(_) => args.clone(),
            _ => return Err(invalid_request("browser arguments must be an object")),
        };
        self.request(
            reqwest::Method::POST,
            &format!("/boxes/{}/browser/{verb}", id.0),
            Some(body),
            None,
            Some(self.timeout.max(DESKTOP_CALL_TIMEOUT)),
        )
        .await
    }

    /// Deliver the Box's short-lived `gwb1` inference key. The service writes
    /// it to a tmpfs file inside the Box; it never enters argv or state.
    pub async fn put_session_credential(
        &self,
        id: &WorkspaceId,
        credential: &SessionCredential,
    ) -> Result<(), BoxApiError> {
        check_box_id(&id.0)?;
        if !credential.key.expose_secret().starts_with("gwb1.") {
            return Err(invalid_request("the session credential must be a gwb1 key"));
        }
        let gateway_url = Url::parse(&credential.gateway_url)
            .map_err(|_| invalid_request("the session credential gateway URL is invalid"))?;
        if !matches!(gateway_url.scheme(), "http" | "https") {
            return Err(invalid_request(
                "the session credential gateway URL must be http(s)",
            ));
        }
        let body = serde_json::to_value(credential)
            .map_err(|_| invalid_request("the session credential could not be encoded"))?;
        self.request(
            reqwest::Method::PUT,
            &format!("/boxes/{}/session-credential", id.0),
            Some(body),
            None,
            None,
        )
        .await?;
        Ok(())
    }

    /// Renew the Box's tick-liveness lease after an accepted Gateway tick.
    pub async fn keepalive(
        &self,
        id: &WorkspaceId,
        tick_index: u64,
        accrued_micro_usd: u64,
    ) -> Result<(), BoxApiError> {
        check_box_id(&id.0)?;
        let body = serde_json::to_value(KeepaliveRequest {
            tick_index,
            accrued_micro_usd,
        })
        .map_err(|_| invalid_request("the keepalive could not be encoded"))?;
        self.request(
            reqwest::Method::POST,
            &format!("/boxes/{}/keepalive", id.0),
            Some(body),
            None,
            None,
        )
        .await?;
        Ok(())
    }

    /// The features the Box service advertises on its `/health` (beside
    /// `/v1`). A service lists `desktop` only when it can run a desktop Box
    /// (it has a desktop image); an older service never lists it.
    pub async fn features(&self) -> Result<Vec<String>, BoxApiError> {
        let root = self
            .base
            .strip_suffix("/v1")
            .unwrap_or(self.base.as_str())
            .to_owned();
        let response = self
            .http
            .get(format!("{root}/health"))
            .timeout(self.timeout.min(Duration::from_secs(5)))
            .send()
            .await
            .map_err(|error| {
                BoxApiError::transport(format!(
                    "Box health request failed: {}",
                    error.without_url()
                ))
            })?;
        let status = response.status();
        let headers = response.headers().clone();
        let text = crate::capture::response_text(response)
            .await
            .map_err(|error| {
                BoxApiError::transport(format!("Box health response failed: {error}"))
            })?;
        if !status.is_success() {
            return Err(parse_box_error(status.as_u16(), &headers, &text));
        }
        let value: Value = serde_json::from_str(&text).map_err(|error| {
            invalid_response(format!("Box health returned invalid JSON: {error}"))
        })?;
        Ok(value
            .get("features")
            .and_then(Value::as_array)
            .map(|features| {
                features
                    .iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default())
    }

    /// The caller tenant's running and stored Box counts and caps.
    pub async fn limits(&self) -> Result<BoxLimits, BoxApiError> {
        let value = self
            .request(reqwest::Method::GET, "/limits", None, None, None)
            .await?;
        let limits = value.get("limits").cloned().unwrap_or(value);
        serde_json::from_value(limits)
            .map_err(|error| invalid_response(format!("Box limits response was invalid: {error}")))
    }
}
