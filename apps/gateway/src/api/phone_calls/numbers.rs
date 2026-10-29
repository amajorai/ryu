//! Number search, purchase and caller-ID verification on the Twilio account.
use super::*;

pub async fn available_numbers(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Query(query): Query<AvailableNumbersQuery>,
) -> Result<Json<AvailablePhoneNumbersView>, GatewayError> {
    authorize(&state, &peer, &headers, "Phone number search").await?;
    let country = query.country_code.trim().to_ascii_uppercase();
    if country.len() != 2 || !country.bytes().all(|byte| byte.is_ascii_uppercase()) {
        return Err(GatewayError::BadRequest(
            "countryCode must be a two-letter ISO country code".to_owned(),
        ));
    }
    if query
        .area_code
        .as_deref()
        .is_some_and(|area| area.len() > 6 || !area.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(GatewayError::BadRequest("areaCode is invalid".to_owned()));
    }
    let credentials = TwilioCredentials::from_env()?;
    let mut form = vec![
        ("VoiceEnabled", "true".to_owned()),
        ("PageSize", "20".to_owned()),
    ];
    if let Some(area_code) = query.area_code {
        form.push(("AreaCode", area_code));
    }
    let result: TwilioAvailableNumbersResponse = twilio_request(
        &state,
        &credentials,
        Method::GET,
        &format!("AvailablePhoneNumbers/{country}/Local"),
        &form,
    )
    .await?;
    Ok(Json(AvailablePhoneNumbersView {
        numbers: result
            .available_phone_numbers
            .into_iter()
            .map(|number| AvailablePhoneNumberView {
                friendly_name: number.friendly_name,
                locality: number.locality,
                phone_number: number.phone_number,
                region: number.region,
            })
            .collect(),
    }))
}

pub async fn purchase_number(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<PurchasePhoneNumberRequest>,
) -> Result<(StatusCode, Json<PurchasedPhoneNumberView>), GatewayError> {
    authorize(&state, &peer, &headers, "Purchase phone number").await?;
    if !is_e164(&request.phone_number) {
        return Err(GatewayError::BadRequest(
            "phoneNumber must be an E.164 phone number".to_owned(),
        ));
    }
    let credentials = TwilioCredentials::from_env()?;
    let voice_url = voice_calls::public_url("/voice/twilio/answer")
        .map_err(|message| GatewayError::BadRequest(message.to_owned()))?;
    if !voice_url.starts_with("https://") {
        return Err(GatewayError::BadRequest(
            "phone calls require a public HTTPS callback URL".to_owned(),
        ));
    }
    let number: TwilioPurchasedNumber = twilio_request(
        &state,
        &credentials,
        Method::POST,
        "IncomingPhoneNumbers",
        &[
            ("PhoneNumber", request.phone_number),
            ("VoiceUrl", voice_url.clone()),
            ("VoiceMethod", "POST".to_owned()),
        ],
    )
    .await?;
    Ok((
        StatusCode::CREATED,
        Json(PurchasedPhoneNumberView {
            phone_number: number.phone_number,
            sid: number.sid,
            voice_url,
        }),
    ))
}

pub async fn verify_caller_id(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(request): Json<VerifyCallerIdRequest>,
) -> Result<Json<VerifyCallerIdView>, GatewayError> {
    authorize(&state, &peer, &headers, "Verify caller ID").await?;
    if !is_e164(&request.phone_number) {
        return Err(GatewayError::BadRequest(
            "phoneNumber must be an E.164 phone number".to_owned(),
        ));
    }
    let credentials = TwilioCredentials::from_env()?;
    let result: TwilioCallerIdVerification = twilio_request(
        &state,
        &credentials,
        Method::POST,
        "OutgoingCallerIds",
        &[
            ("PhoneNumber", request.phone_number),
            ("FriendlyName", "Ryu phone assistant".to_owned()),
        ],
    )
    .await?;
    Ok(Json(VerifyCallerIdView {
        call_sid: result.call_sid,
        phone_number: result.phone_number,
        validation_code: result.validation_code,
    }))
}
