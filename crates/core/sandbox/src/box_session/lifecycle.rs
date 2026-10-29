//! Box lifecycle verbs: create a disposable Box and wait until it is ready,
//! park, resume, and status.

use super::*;

impl BoxSessionClient {
    /// Create a disposable Box and wait until it is ready. The service may
    /// answer `201` (sync drivers) or `202` (async VM placement); both are
    /// followed by polling.
    pub async fn create_disposable(
        &self,
        spec: &DisposableBoxSpec,
        idempotency_key: &str,
    ) -> Result<WorkspaceId, BoxApiError> {
        validate_labels(&spec.labels)?;
        let value = self
            .request(
                reqwest::Method::POST,
                "/boxes",
                Some(create_body(spec)),
                Some(idempotency_key),
                None,
            )
            .await?;
        let id = value
            .get("box")
            .and_then(|box_value| box_value.get("id"))
            .and_then(Value::as_str)
            .ok_or_else(|| invalid_response("Box create response did not contain box.id"))?;
        check_box_id(id)?;
        let id = WorkspaceId(id.to_owned());
        self.wait_until_ready(&id).await?;
        Ok(id)
    }

    /// Poll `GET /boxes/:id` until the Box is `ready` (or `running`), and
    /// fail when it settles anywhere else.
    async fn wait_until_ready(&self, id: &WorkspaceId) -> Result<BoxView, BoxApiError> {
        let deadline = Instant::now() + READY_DEADLINE;
        loop {
            let value = self
                .request(
                    reqwest::Method::GET,
                    &format!("/boxes/{}", id.0),
                    None,
                    None,
                    None,
                )
                .await?;
            let box_value = value.get("box").ok_or_else(|| {
                invalid_response(format!("Box {} response did not contain box", id.0))
            })?;
            let status = box_value
                .get("status")
                .or_else(|| box_value.get("state"))
                .and_then(Value::as_str)
                .ok_or_else(|| {
                    invalid_response(format!("Box {} response did not contain a status", id.0))
                })?;
            match status {
                "ready" | "running" => return parse_box_view(box_value),
                "error" | "deleted" | "stopped" | "archived" => {
                    let last_error = box_value
                        .get("lastError")
                        .and_then(Value::as_str)
                        .map(|text| text.chars().take(LAST_ERROR_CHARS).collect::<String>())
                        .unwrap_or_else(|| "no error detail".to_owned());
                    return Err(BoxApiError::Http {
                        status: 409,
                        code: "box_not_runnable".to_owned(),
                        message: format!("Box {} is not runnable ({status}): {last_error}", id.0),
                    });
                }
                _ => {}
            }
            if Instant::now() + READY_POLL_INTERVAL > deadline {
                return Err(BoxApiError::Http {
                    status: 504,
                    code: "box_ready_timeout".to_owned(),
                    message: format!("Box {} did not become ready before the timeout", id.0),
                });
            }
            tokio::time::sleep(READY_POLL_INTERVAL).await;
        }
    }

    /// Park a Box: `POST /boxes/:id/stop {reason}`. On VM drivers the service
    /// saves its state and releases the machine; the stored Box stays.
    pub async fn park(&self, id: &WorkspaceId, reason: ParkReason) -> Result<(), BoxApiError> {
        check_box_id(&id.0)?;
        self.request(
            reqwest::Method::POST,
            &format!("/boxes/{}/stop", id.0),
            Some(json!({ "reason": reason.as_str() })),
            None,
            None,
        )
        .await?;
        Ok(())
    }

    /// Resume a parked Box and wait until it is ready again. A Box that is
    /// already live is returned as it is.
    pub async fn resume(&self, id: &WorkspaceId) -> Result<BoxView, BoxApiError> {
        check_box_id(&id.0)?;
        let value = self
            .request(
                reqwest::Method::POST,
                &format!("/boxes/{}/resume", id.0),
                None,
                None,
                None,
            )
            .await?;
        if let Some(box_value) = value.get("box") {
            let view = parse_box_view(box_value)?;
            if view.status.is_live() {
                return Ok(view);
            }
        }
        self.wait_until_ready(id).await
    }

    /// Read one Box.
    pub async fn status(&self, id: &WorkspaceId) -> Result<BoxView, BoxApiError> {
        check_box_id(&id.0)?;
        let value = self
            .request(
                reqwest::Method::GET,
                &format!("/boxes/{}", id.0),
                None,
                None,
                None,
            )
            .await?;
        let box_value = value.get("box").ok_or_else(|| {
            invalid_response(format!("Box {} response did not contain box", id.0))
        })?;
        parse_box_view(box_value)
    }
}
