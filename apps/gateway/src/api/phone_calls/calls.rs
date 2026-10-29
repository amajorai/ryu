//! Outbound call placement and live-call controls (steer, hand off, hang up).
use super::*;

pub async fn start_call(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<StartPhoneCallRequest>,
) -> Result<(StatusCode, Json<StartPhoneCallResponse>), GatewayError> {
    authorize(&state, &peer, &headers, "Outbound phone calls").await?;
    if !valid_idempotency_key(&request.idempotency_key) {
        return Err(GatewayError::BadRequest(
            "idempotencyKey must be 16 to 128 safe characters".to_owned(),
        ));
    }
    if !is_e164(&request.to) {
        return Err(GatewayError::BadRequest(
            "destination must be an E.164 phone number".to_owned(),
        ));
    }
    let goal = request.goal.trim();
    if goal.is_empty() || goal.chars().count() > 2_000 || goal.contains('\0') {
        return Err(GatewayError::BadRequest(
            "call goal must contain 1 to 2000 valid characters".to_owned(),
        ));
    }
    let config = load_phone_config()?;
    if !config.enabled {
        return Err(GatewayError::BadRequest(
            "phone assistant is disabled in Gateway settings".to_owned(),
        ));
    }
    if !voice_provider_ready() {
        return Err(GatewayError::ProviderError(
            "Twilio voice is not fully configured for live calls".to_owned(),
        ));
    }
    let line = find_line(&config, &request.line_id)?;
    let credentials = TwilioCredentials::from_env()?;
    let caller_id = outbound_caller_id(line);
    let callback = match voice_calls::public_url("/voice/twilio/outbound/PLACEHOLDER") {
        Ok(url) => url,
        Err(message) => return Err(GatewayError::BadRequest(message.to_owned())),
    };
    let (callback_origin, _) = callback
        .rsplit_once("/voice/twilio/outbound/PLACEHOLDER")
        .ok_or_else(|| {
            GatewayError::Internal(anyhow::anyhow!("Twilio callback URL is malformed"))
        })?;
    let status_callback_origin = voice_calls::public_url("/voice/twilio/status/PLACEHOLDER")
        .map_err(|message| GatewayError::BadRequest(message.to_owned()))?;
    let (status_callback_origin, _) = status_callback_origin
        .rsplit_once("/voice/twilio/status/PLACEHOLDER")
        .ok_or_else(|| GatewayError::Internal(anyhow::anyhow!("Twilio status URL is malformed")))?;
    let fingerprint_input = format!("{}\n{}\n{}", line.id, request.to, goal);
    let fingerprint = hex::encode(Sha256::digest(fingerprint_input.as_bytes()));
    // Refuse an unusable caller ID before anything is recorded: once the
    // request is journaled, a retry with its key is told it is pending, which
    // a refusal after that point would leave untrue.
    require_usable_caller_id(&state, &credentials, line, caller_id).await?;
    // Take the line slot before anything reaches Twilio: a call placed on a
    // full line would ring, and be charged, only to be dropped when its media
    // stream starts. A repeated request takes no second slot.
    let reservation = state
        .phone_calls
        .reserve_outbound(
            request.idempotency_key.clone(),
            fingerprint,
            line.id.clone(),
            outbound_opening_prompt(line, goal),
            line.concurrent_call_limit(),
        )
        .await
        .map_err(GatewayError::BadRequest)?;
    let intent_id = match reservation {
        crate::phone_calls::CallReservation::Existing { call_sid } => {
            return Ok((
                StatusCode::OK,
                Json(StartPhoneCallResponse {
                    conversation_id: voice_calls::conversation_id(
                        &credentials.account_sid,
                        &call_sid,
                    ),
                    call_sid: Some(call_sid),
                    idempotency_key: request.idempotency_key,
                    status: "existing".to_owned(),
                }),
            ));
        }
        crate::phone_calls::CallReservation::Pending => {
            return Ok((
                StatusCode::ACCEPTED,
                Json(StartPhoneCallResponse {
                    call_sid: None,
                    conversation_id: None,
                    idempotency_key: request.idempotency_key,
                    status: "pending".to_owned(),
                }),
            ));
        }
        crate::phone_calls::CallReservation::LineBusy => {
            tracing::warn!(line = %line.id, "phone line is at its simultaneous-call limit; outbound call not placed");
            // A temporary capacity refusal, like the Gateway's other busy
            // answers (503), so a client retries it later rather than treating
            // it as invalid input.
            return Err(GatewayError::Overloaded(PHONE_LINE_BUSY.to_owned()));
        }
        crate::phone_calls::CallReservation::Created { intent_id } => intent_id,
    };
    let callback = format!("{callback_origin}/voice/twilio/outbound/{intent_id}");
    let status_callback = format!("{status_callback_origin}/voice/twilio/status/{intent_id}");
    let body = match twilio_request::<Value>(
        &state,
        &credentials,
        Method::POST,
        TWILIO_CALLS_PATH,
        &[
            ("To", request.to),
            ("From", caller_id.to_owned()),
            ("Url", callback),
            ("Method", "POST".to_owned()),
            ("StatusCallback", status_callback),
            ("StatusCallbackMethod", "POST".to_owned()),
            ("StatusCallbackEvent", "initiated".to_owned()),
            ("StatusCallbackEvent", "ringing".to_owned()),
            ("StatusCallbackEvent", "answered".to_owned()),
            ("StatusCallbackEvent", "completed".to_owned()),
            (
                "Timeout",
                crate::phone_calls::OUTBOUND_RING_TIMEOUT
                    .as_secs()
                    .to_string(),
            ),
        ],
    )
    .await
    {
        Ok(body) => body,
        Err(error) => {
            // A refused call frees its intent and slot. After any other failure
            // the call may still have been placed, so both stay until its status
            // callback reports the outcome or the slot's ring bound passes.
            if is_definitive_twilio_rejection(&error) {
                let _ = state.phone_calls.remove_intent(&intent_id).await;
            }
            return Err(error);
        }
    };
    let call_sid = body
        .get("sid")
        .and_then(Value::as_str)
        .filter(|sid| valid_call_sid(sid))
        .ok_or_else(|| GatewayError::ProviderError("Twilio returned no call id".to_owned()))?
        .to_owned();
    if !state
        .phone_calls
        .record_call_sid(&intent_id, &call_sid)
        .await
        .map_err(|error| GatewayError::Internal(anyhow::anyhow!(error)))?
    {
        return Err(GatewayError::ProviderError(
            "Twilio call id conflicts with the pending request".to_owned(),
        ));
    }
    Ok((
        StatusCode::CREATED,
        Json(StartPhoneCallResponse {
            conversation_id: voice_calls::conversation_id(&credentials.account_sid, &call_sid),
            call_sid: Some(call_sid),
            idempotency_key: request.idempotency_key,
            status: body
                .get("status")
                .and_then(Value::as_str)
                .unwrap_or("queued")
                .to_owned(),
        }),
    ))
}

pub async fn control_call(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(call_sid): Path<String>,
    Json(request): Json<ControlPhoneCallRequest>,
) -> Result<Json<PhoneCallActionResponse>, GatewayError> {
    authorize(&state, &peer, &headers, "Live phone call control").await?;
    validate_call_sid(&call_sid)?;
    let frame = match (request.action.as_deref(), request.content) {
        (Some("abort"), None) => json!({ "type": "abort" }),
        (None, Some(content)) => {
            let content = content.trim();
            if content.is_empty() || content.chars().count() > 1_000 || content.contains('\0') {
                return Err(GatewayError::BadRequest(
                    "call guidance must contain 1 to 1000 valid characters".to_owned(),
                ));
            }
            json!({
                "type": "text",
                "content": format!("The account owner is guiding you: {content}"),
            })
        }
        _ => {
            return Err(GatewayError::BadRequest(
                "provide either content or action=abort".to_owned(),
            ));
        }
    };
    let frame =
        serde_json::to_string(&frame).map_err(|error| GatewayError::Internal(error.into()))?;
    if !state.phone_calls.send(&call_sid, frame).await {
        return Err(GatewayError::BadRequest(
            "that call is no longer connected to the live assistant".to_owned(),
        ));
    }
    Ok(Json(PhoneCallActionResponse {
        ok: true,
        status: None,
    }))
}

pub async fn handoff_call(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(call_sid): Path<String>,
    Json(request): Json<PhoneCallLineRequest>,
) -> Result<Json<PhoneCallActionResponse>, GatewayError> {
    authorize(&state, &peer, &headers, "Phone call handoff").await?;
    validate_call_sid(&call_sid)?;
    let config = load_phone_config()?;
    let line = find_line(&config, &request.line_id)?;
    let transfer_to = line.transfer_to.as_deref().ok_or_else(|| {
        GatewayError::BadRequest("this phone line has no handoff number".to_owned())
    })?;
    let credentials = TwilioCredentials::from_env()?;
    let twiml = format!(
        "<Response><Say>Connecting you with the account owner.</Say><Dial callerId=\"{}\" answerOnBridge=\"true\"><Number>{}</Number></Dial></Response>",
        xml_escape(&line.caller_id),
        xml_escape(transfer_to),
    );
    let body = twilio_request::<Value>(
        &state,
        &credentials,
        Method::POST,
        &format!("{TWILIO_CALLS_PATH}/{call_sid}"),
        &[("Twiml", twiml)],
    )
    .await?;
    Ok(Json(PhoneCallActionResponse {
        ok: true,
        status: body
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }))
}

pub async fn hangup_call(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Path(call_sid): Path<String>,
) -> Result<Json<PhoneCallActionResponse>, GatewayError> {
    authorize(&state, &peer, &headers, "End phone call").await?;
    validate_call_sid(&call_sid)?;
    let credentials = TwilioCredentials::from_env()?;
    let body = twilio_request::<Value>(
        &state,
        &credentials,
        Method::POST,
        &format!("{TWILIO_CALLS_PATH}/{call_sid}"),
        &[("Status", "completed".to_owned())],
    )
    .await?;
    Ok(Json(PhoneCallActionResponse {
        ok: true,
        status: body
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_owned),
    }))
}
