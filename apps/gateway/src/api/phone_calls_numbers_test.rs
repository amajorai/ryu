//! Phone call listing (`GET /v1/phone-calls`) and number search/purchase
//! (`/v1/phone-calls/numbers{,/available}`), driven through the real handlers
//! against the recording Twilio stand-in in [`super::phone_calls_live`].

use super::phone_calls_live::{
    admin, bad_request_message, line, peer, phone_api_fixture, LINE_CALLER_ID, LINE_NUMBER,
    LINE_TRANSFER,
};
use super::*;

const SECOND_NUMBER: &str = "+15550004444";

fn twilio_call(sid: &str, from: &str, to: &str) -> Value {
    serde_json::json!({ "sid": sid, "status": "completed", "direction": "outbound-api", "from": from, "to": to, "start_time": null, "end_time": null, "duration": "12" })
}

fn sid(n: u8) -> String {
    format!("CA{n:032x}")
}

async fn list(fixture: &super::phone_calls_live::PhoneApiFixture) -> Value {
    let Json(response) = crate::api::phone_calls::list_calls(
        State(fixture.state.clone()),
        peer("127.0.0.1:4000"),
        admin(),
    )
    .await
    .unwrap();
    serde_json::to_value(response).unwrap()
}

/// Only calls that touch a configured line number are listed; each is tied to
/// its line (intent, then Twilio number, then caller ID) under a
/// conversation id that carries no phone number.
#[tokio::test]
async fn listing_keeps_only_line_calls_and_attributes_each_to_its_line() {
    let fixture = phone_api_fixture(
        "phone-list",
        vec![
            line("fixture", LINE_NUMBER, LINE_CALLER_ID, Some(LINE_TRANSFER)),
            line("second", SECOND_NUMBER, "", None),
        ],
        ACCOUNT,
    )
    .await;
    let reservation = fixture
        .state
        .phone_calls
        .reserve_outbound(
            "list-request-000001".into(),
            "fp".into(),
            "second".into(),
            "goal".into(),
            2,
        )
        .await
        .unwrap();
    let crate::phone_calls::CallReservation::Created { intent_id } = reservation else {
        panic!("expected a new intent")
    };
    assert!(fixture
        .state
        .phone_calls
        .record_call_sid(&intent_id, &sid(4))
        .await
        .unwrap());
    *fixture.twilio.calls.lock().unwrap() = serde_json::json!({ "calls": [
        twilio_call(&sid(1), "+15559990000", "+15559991111"),
        twilio_call(&sid(2), "+15551234567", SECOND_NUMBER),
        twilio_call(&sid(3), LINE_CALLER_ID, "+15557654321"),
        twilio_call(&sid(4), LINE_CALLER_ID, "+15557654321"),
        twilio_call(&sid(5), LINE_CALLER_ID, SECOND_NUMBER),
        twilio_call(&sid(6), LINE_TRANSFER, "+15559990000"),
    ] });

    let response = list(&fixture).await;
    assert_eq!(response["twilioConfigured"], true);
    assert_eq!(
        response["verifiedCallerIds"],
        serde_json::json!([LINE_CALLER_ID])
    );
    let calls = response["calls"].as_array().unwrap();
    let listed = calls
        .iter()
        .map(|call| {
            (
                call["callSid"].as_str().unwrap().to_owned(),
                call["lineId"].clone(),
            )
        })
        .collect::<Vec<_>>();
    assert_eq!(
        listed,
        vec![
            (sid(2), serde_json::json!("second")),
            (sid(3), serde_json::json!("fixture")),
            (sid(4), serde_json::json!("second")),
            (sid(5), serde_json::json!("second")),
            (sid(6), Value::Null),
        ],
        "another account call is left out; intent, then Twilio number, then caller ID decide the line"
    );
    assert!(
        !response.to_string().contains("+15559991111"),
        "unrelated traffic is not exposed"
    );
    for call in calls {
        let conversation = call["conversationId"].as_str().unwrap();
        assert_eq!(
            Some(conversation.to_owned()),
            conversation_id(ACCOUNT, call["callSid"].as_str().unwrap())
        );
        for number in [
            LINE_NUMBER,
            LINE_CALLER_ID,
            LINE_TRANSFER,
            SECOND_NUMBER,
            "+15551234567",
        ] {
            assert!(
                !conversation.contains(&number[2..]),
                "{conversation} carries {number}"
            );
        }
    }
    let requests = fixture.twilio.requests();
    assert!(requests
        .iter()
        .any(|request| request.method == "GET" && request.path.ends_with("/Calls.json")));
}

/// Without Twilio credentials the listing reports that and asks Twilio nothing.
#[tokio::test]
async fn listing_without_twilio_credentials_makes_no_request() {
    let fixture = phone_api_fixture(
        "phone-list-unconfigured",
        vec![line("fixture", LINE_NUMBER, "", None)],
        "",
    )
    .await;
    let response = list(&fixture).await;
    assert_eq!(response["twilioConfigured"], false);
    assert_eq!(response["calls"], serde_json::json!([]));
    assert_eq!(response["verifiedCallerIds"], serde_json::json!([]));
    assert_eq!(response["lines"][0]["id"], "fixture");
    assert!(fixture.twilio.requests().is_empty());
}

async fn search(
    fixture: &super::phone_calls_live::PhoneApiFixture,
    country: &str,
    area: Option<&str>,
) -> Result<Json<crate::api::phone_calls::AvailablePhoneNumbersView>, crate::error::GatewayError> {
    crate::api::phone_calls::available_numbers(
        State(fixture.state.clone()),
        peer("127.0.0.1:4000"),
        admin(),
        axum::extract::Query(crate::api::phone_calls::AvailableNumbersQuery {
            country_code: country.to_owned(),
            area_code: area.map(str::to_owned),
        }),
    )
    .await
}

async fn purchase(
    fixture: &super::phone_calls_live::PhoneApiFixture,
    number: &str,
) -> Result<
    (
        StatusCode,
        Json<crate::api::phone_calls::PurchasedPhoneNumberView>,
    ),
    crate::error::GatewayError,
> {
    crate::api::phone_calls::purchase_number(
        State(fixture.state.clone()),
        peer("127.0.0.1:4000"),
        admin(),
        Json(crate::api::phone_calls::PurchasePhoneNumberRequest {
            phone_number: number.to_owned(),
        }),
    )
    .await
}

/// Number search validates its country and area code before asking Twilio.
#[tokio::test]
async fn number_search_validates_country_and_area_code() {
    let fixture = phone_api_fixture(
        "phone-number-search",
        vec![line("fixture", LINE_NUMBER, "", None)],
        ACCOUNT,
    )
    .await;
    for (country, area) in [
        ("usa", None),
        ("1", None),
        ("u1", None),
        ("us", Some("1234567")),
        ("us", Some("41a")),
    ] {
        bad_request_message(search(&fixture, country, area).await);
    }
    assert!(
        fixture.twilio.requests().is_empty(),
        "invalid searches never reach Twilio"
    );

    let Json(found) = search(&fixture, " us ", Some("415")).await.unwrap();
    assert_eq!(
        serde_json::to_value(found).unwrap()["numbers"][0]["phoneNumber"],
        "+14155550199"
    );
    let requests = fixture.twilio.requests();
    assert_eq!(requests.len(), 1);
    assert!(
        requests[0].path.ends_with(&format!(
            "/Accounts/{ACCOUNT}/AvailablePhoneNumbers/US/Local.json"
        )),
        "{requests:?}"
    );
    assert!(requests[0].query.contains("AreaCode=415"), "{requests:?}");
}

/// A purchase needs an E.164 number and a public HTTPS voice URL, and points
/// the number's voice webhook at the Gateway answer route.
#[tokio::test]
async fn number_purchase_requires_e164_and_https_and_registers_the_answer_url() {
    let fixture = phone_api_fixture(
        "phone-number-purchase",
        vec![line("fixture", LINE_NUMBER, "", None)],
        ACCOUNT,
    )
    .await;
    bad_request_message(purchase(&fixture, "4155550199").await);
    {
        let _http = EnvRestore::set(&[(PUBLIC_URL_ENV, "http://voice.example.test".to_owned())]);
        assert_eq!(
            bad_request_message(purchase(&fixture, "+14155550199").await),
            "phone calls require a public HTTPS callback URL"
        );
    }
    assert!(fixture.twilio.requests().is_empty(), "no number is bought");

    let (status, Json(bought)) = purchase(&fixture, "+14155550199").await.unwrap();
    assert_eq!(status, StatusCode::CREATED);
    let bought = serde_json::to_value(bought).unwrap();
    assert_eq!(bought["phoneNumber"], "+14155550199");
    assert_eq!(
        bought["voiceUrl"],
        "https://voice.example.test/voice/twilio/answer"
    );
    let requests = fixture.twilio.requests();
    assert_eq!(requests.len(), 1);
    assert_eq!(requests[0].method, "POST");
    assert!(requests[0].path.ends_with("/IncomingPhoneNumbers.json"));
    assert_eq!(
        form_value(&requests[0].body, "VoiceUrl").as_deref(),
        Some("https://voice.example.test/voice/twilio/answer")
    );
    assert_eq!(
        form_value(&requests[0].body, "VoiceMethod").as_deref(),
        Some("POST")
    );
}
