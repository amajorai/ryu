//! The Twilio Media Streams session: relays caller audio to Core's voice
//! session and plays Core's replies back to the caller.
use super::*;

pub(super) async fn handle_twilio_stream(
    socket: WebSocket,
    state: SharedState,
    auth_token: String,
) {
    let (mut twilio_tx, mut twilio_rx) = socket.split();
    // The upgrade signature covers its URL, not subsequent start parameters.
    // Verify the answer-issued call binding before opening a Core conversation.
    let (incoming_sid, call_sid, start, initial_prompt, line_id, call_limit) = loop {
        let Some(Ok(frame)) = twilio_rx.next().await else {
            return;
        };
        let text = match frame {
            axum::extract::ws::Message::Text(text) => text,
            axum::extract::ws::Message::Ping(payload) => {
                if twilio_tx
                    .send(axum::extract::ws::Message::Pong(payload))
                    .await
                    .is_err()
                {
                    return;
                }
                continue;
            }
            axum::extract::ws::Message::Pong(_) | axum::extract::ws::Message::Binary(_) => continue,
            axum::extract::ws::Message::Close(_) => return,
        };
        match parse_twilio_event(&text) {
            Ok(TwilioMediaEvent::Start {
                stream_sid, start, ..
            }) => {
                if validate_twilio_start(&start).is_err() {
                    return;
                }
                let Some(conversation) = conversation_id(&start.account_sid, &start.call_sid)
                else {
                    return;
                };
                let expected = stream_binding(
                    &start.account_sid,
                    &start.call_sid,
                    &auth_token,
                    start
                        .custom_parameters
                        .get("lineId")
                        .map(String::as_str)
                        .unwrap_or(""),
                    start
                        .custom_parameters
                        .get("callKind")
                        .map(String::as_str)
                        .unwrap_or(""),
                    start
                        .custom_parameters
                        .get("callerNumber")
                        .map(String::as_str),
                );
                if !start
                    .custom_parameters
                    .get("callBinding")
                    .is_some_and(|binding| {
                        constant_time_equal(expected.as_bytes(), binding.as_bytes())
                    })
                {
                    return;
                }
                let Some(line_id) = start.custom_parameters.get("lineId") else {
                    tracing::warn!("twilio media stream has no configured line id");
                    return;
                };
                let config = match GatewayConfig::load() {
                    Ok(config) if config.channels.phone_calls.enabled => config,
                    Ok(_) => {
                        tracing::warn!("phone assistant was disabled before media stream start");
                        return;
                    }
                    Err(error) => {
                        tracing::warn!(%error, "phone-call config could not be loaded for media stream");
                        return;
                    }
                };
                let Some(line) = config
                    .channels
                    .phone_calls
                    .lines
                    .iter()
                    .find(|line| line.id == *line_id)
                else {
                    tracing::warn!(
                        line_id,
                        "twilio media stream references an unknown phone line"
                    );
                    return;
                };
                // Caller trust travels to Core as data, not only as prompt text:
                // an inbound caller the line does not list is unverified, and Core
                // restricts that session's tools. Outbound calls carry the owner's
                // own authenticated request, so they keep the owner's session.
                let (initial_prompt, caller_trusted) = match start
                    .custom_parameters
                    .get("callKind")
                    .map(String::as_str)
                {
                    Some("inbound") => {
                        let caller = start
                            .custom_parameters
                            .get("callerNumber")
                            .map(String::as_str)
                            .unwrap_or("unknown");
                        // Re-check against the live config: the allowlist may
                        // have changed between the answer webhook and now.
                        if !line.accepts_caller(caller) {
                            tracing::warn!(line = %line.id, "inbound media stream caller is outside the line allowlist");
                            return;
                        }
                        let caller_trusted = line.lists_caller(caller);
                        (
                            inbound_opening_prompt(
                                &line.label,
                                &line.greeting,
                                caller,
                                line.transfer_to.as_deref(),
                                caller_trusted,
                            ),
                            caller_trusted,
                        )
                    }
                    Some("outbound") => {
                        let Some(intent) =
                            state.phone_calls.get_intent_for_call(&start.call_sid).await
                        else {
                            tracing::warn!(call_sid = %start.call_sid, "outbound media stream has no matching call intent");
                            return;
                        };
                        if intent.line_id != line.id {
                            tracing::warn!(call_sid = %start.call_sid, "outbound media stream line does not match call intent");
                            return;
                        }
                        (intent.goal, true)
                    }
                    _ => {
                        tracing::warn!("twilio media stream has an unknown call kind");
                        return;
                    }
                };
                let message = core_start_frame(
                    &conversation,
                    line.agent_id.as_deref(),
                    line.tts_engine.as_deref(),
                    line.tts_voice.as_deref(),
                    caller_trusted,
                );
                break (
                    stream_sid,
                    start.call_sid,
                    message,
                    initial_prompt,
                    line.id.clone(),
                    line.concurrent_call_limit(),
                );
            }
            Ok(TwilioMediaEvent::Connected { .. } | TwilioMediaEvent::Mark { .. }) => {}
            _ => return,
        }
    };
    let conversation = start["conversation_id"]
        .as_str()
        .expect("validated call conversation");
    // Hold the line's call slot before opening a Core voice session, so a flood
    // of calls cannot start more speech/model/voice sessions than the cap. An
    // inbound call takes over the slot its answer webhook reserved; any other
    // stream must find a free one.
    let (control_tx, mut control_rx) = tokio::sync::mpsc::channel::<String>(16);
    if !state
        .phone_calls
        .try_register(call_sid.clone(), line_id, control_tx, call_limit)
        .await
    {
        tracing::warn!(call_sid = %call_sid, "phone line is at its simultaneous-call limit; ending media stream");
        return;
    }
    let core_url = match core_ws_url(conversation).await {
        Ok(url) => url,
        Err(error) => {
            tracing::warn!(%error, "twilio voice bridge could not resolve Core URL");
            state.phone_calls.remove(&call_sid).await;
            return;
        }
    };
    let (core, _) = match connect_async(core_url).await {
        Ok(connection) => connection,
        Err(error) => {
            tracing::warn!(%error, "twilio voice bridge could not connect to Core voice");
            state.phone_calls.remove(&call_sid).await;
            return;
        }
    };

    let (mut core_tx, mut core_rx) = core.split();
    if core_tx
        .send(CoreMessage::Text(start.to_string().into()))
        .await
        .is_err()
    {
        state.phone_calls.remove(&call_sid).await;
        return;
    }
    let stream_sid = Some(incoming_sid);
    let active_call_sid = Some(call_sid);
    let core_started = true;
    let message = serde_json::json!({ "type": "text", "content": initial_prompt });
    if core_tx
        .send(CoreMessage::Text(message.to_string().into()))
        .await
        .is_err()
    {
        if let Some(call_sid) = active_call_sid.as_deref() {
            state.phone_calls.remove(call_sid).await;
        }
        return;
    }
    loop {
        tokio::select! {
            frame = twilio_rx.next() => {
                let Some(Ok(frame)) = frame else { break };
                match frame {
                    axum::extract::ws::Message::Text(text) => {
                        let event = match parse_twilio_event(&text) {
                            Ok(event) => event,
                            Err(error) => {
                                tracing::warn!(%error, "twilio voice bridge rejected malformed event");
                                break;
                            }
                        };
                        match event {
                            TwilioMediaEvent::Connected { .. } | TwilioMediaEvent::Mark { .. } => {}
                            TwilioMediaEvent::Start { .. } => {}
                            TwilioMediaEvent::Media { media, .. } if media.track == "inbound" => {
                                let samples = match decode_twilio_audio(&media.payload) {
                                    Ok(samples) => samples,
                                    Err(error) => {
                                        tracing::warn!(%error, "twilio voice bridge rejected audio payload");
                                        break;
                                    }
                                };
                                if core_tx.send(CoreMessage::Binary(pcm_bytes(&samples).into())).await.is_err() {
                                    break;
                                }
                            }
                            TwilioMediaEvent::Media { .. } | TwilioMediaEvent::Dtmf { .. } => {}
                            TwilioMediaEvent::Stop { .. } => break,
                        }
                    }
                    axum::extract::ws::Message::Ping(payload) => {
                        if twilio_tx.send(axum::extract::ws::Message::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    axum::extract::ws::Message::Close(_) => break,
                    axum::extract::ws::Message::Binary(_) | axum::extract::ws::Message::Pong(_) => {}
                }
            }
            frame = core_rx.next() => {
                let Some(Ok(frame)) = frame else { break };
                match frame {
                    CoreMessage::Text(text) => {
                        let value: Value = match serde_json::from_str(&text) {
                            Ok(value) => value,
                            Err(error) => {
                                tracing::warn!(%error, "Core voice bridge emitted malformed control frame");
                                break;
                            }
                        };
                        match value["type"].as_str() {
                            Some("stop_playback") => {
                                if let Some(stream_sid) = stream_sid.as_deref() {
                                    let _ = twilio_tx.send(axum::extract::ws::Message::Text(
                                        twilio_clear_message(stream_sid).into(),
                                    )).await;
                                }
                            }
                            Some("error") => {
                                tracing::warn!(message = ?value["message"], "Core voice session failed");
                                break;
                            }
                            _ => {}
                        }
                    }
                    CoreMessage::Binary(wav) => {
                        let Some(stream_sid) = stream_sid.as_deref() else { continue };
                        let encoded = match wav_to_twilio_audio(&wav) {
                            Ok(encoded) => encoded,
                            Err(error) => {
                                tracing::warn!(%error, "Core voice bridge received unsupported WAV");
                                break;
                            }
                        };
                        let payload = match BASE64.decode(encoded) {
                            Ok(payload) => payload,
                            Err(error) => {
                                tracing::warn!(%error, "Core voice bridge failed to encode media");
                                break;
                            }
                        };
                        for chunk in payload.chunks(TWILIO_MULAW_FRAME_BYTES) {
                            if twilio_tx.send(axum::extract::ws::Message::Text(
                                twilio_media_payload_message(stream_sid, chunk).into(),
                            )).await.is_err() {
                                break;
                            }
                        }
                    }
                    CoreMessage::Ping(payload) => {
                        if core_tx.send(CoreMessage::Pong(payload)).await.is_err() {
                            break;
                        }
                    }
                    CoreMessage::Close(_) => break,
                    CoreMessage::Pong(_) | CoreMessage::Frame(_) => {}
                }
            }
            control = control_rx.recv(), if core_started => {
                let Some(control) = control else { continue };
                if core_tx.send(CoreMessage::Text(control.into())).await.is_err() {
                    break;
                }
            }
        }
    }

    if let Some(call_sid) = active_call_sid {
        state.phone_calls.remove(&call_sid).await;
        summarize_completed_call(&mut core_tx, &mut core_rx).await;
    }
    let _ = core_tx.send(CoreMessage::Close(None)).await;
}

async fn summarize_completed_call(
    core_tx: &mut futures_util::stream::SplitSink<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
        CoreMessage,
    >,
    core_rx: &mut futures_util::stream::SplitStream<
        tokio_tungstenite::WebSocketStream<
            tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
        >,
    >,
) {
    let prompt = format!(
        "{PHONE_CALL_SUMMARY_PREFIX} The call ended. Summarize the transcript concisely with the outcome, important details, and next steps. Use only the conversation. Do not place another call, send a message, or take any new action."
    );
    let request = serde_json::json!({ "type": "summary" });
    if core_tx
        .send(CoreMessage::Text(request.to_string().into()))
        .await
        .is_err()
    {
        return;
    }

    let wait_for_summary = async {
        let mut saw_request_echo = false;
        while let Some(Ok(frame)) = core_rx.next().await {
            let CoreMessage::Text(text) = frame else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(&text) else {
                continue;
            };
            if value["type"].as_str() == Some("stt")
                && value["text"].as_str() == Some(prompt.as_str())
                && value["final"].as_bool() == Some(true)
            {
                saw_request_echo = true;
                continue;
            }
            if saw_request_echo && value["type"].as_str() == Some("chat_end") {
                break;
            }
            if value["type"].as_str() == Some("error") {
                break;
            }
        }
    };
    let _ = tokio::time::timeout(std::time::Duration::from_secs(30), wait_for_summary).await;
}
