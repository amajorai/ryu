use super::*;

async fn response_json(response: Response) -> (StatusCode, serde_json::Value) {
    let status = response.status();
    let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
        .await
        .expect("body");
    (status, serde_json::from_slice(&bytes).expect("json body"))
}

fn app_call(provider: &str) -> ManagedProviderCall {
    serde_json::from_value(json!({
        "provider": provider,
        "toolId": "x.post.create",
        "method": "POST",
        "requestId": "req-1",
        "providerPin": "treg"
    }))
    .expect("call")
}

#[tokio::test]
async fn a_satellite_cannot_reach_treg_past_a_composio_pin() {
    let (status, body) =
        response_json(refuse_pinned(&app_call("treg"), Some(ProviderPin::Composio)).unwrap()).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"]["code"], "policy_violation");
    assert_eq!(body["error"]["pinnedProvider"], "composio");
    // Composio and `builtin` calls go on to Gateway, which applies the pin.
    assert!(refuse_pinned(&app_call("composio"), Some(ProviderPin::Composio)).is_none());
    assert!(refuse_pinned(&app_call("builtin"), Some(ProviderPin::Composio)).is_none());
    assert!(refuse_pinned(&app_call("treg"), Some(ProviderPin::Treg)).is_none());
    assert!(refuse_pinned(&app_call("treg"), None).is_none());
}

#[tokio::test]
async fn typed_credit_refusals_reach_the_app_with_their_status_and_body() {
    let gateway_402 = json!({
        "error": {
            "type": "insufficient_credits",
            "code": "insufficient_credits",
            "balance_micro_usd": 1000,
            "estimate_micro_usd": 2200,
            "top_up_url": "https://ryuhq.com/organizations/billing"
        }
    });
    let (status, body) = response_json(failed(ProviderRouterError::Rejected {
        status: 402,
        body: gateway_402.to_string(),
    }))
    .await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    assert_eq!(body, gateway_402, "the top-up link survives the hop");

    for (code, gateway_code, expected) in [
        (403, "tool_unpriced", StatusCode::FORBIDDEN),
        (
            503,
            "credit_accounting_unavailable",
            StatusCode::SERVICE_UNAVAILABLE,
        ),
    ] {
        let gateway_body = json!({ "error": { "code": gateway_code } });
        let (status, body) = response_json(failed(ProviderRouterError::Rejected {
            status: code,
            body: gateway_body.to_string(),
        }))
        .await;
        assert_eq!(status, expected);
        assert_eq!(body["error"]["code"], gateway_code);
    }

    // A non-JSON refusal keeps its status with Core's own message.
    let (status, body) = response_json(failed(ProviderRouterError::Rejected {
        status: 402,
        body: "payment required".to_owned(),
    }))
    .await;
    assert_eq!(status, StatusCode::PAYMENT_REQUIRED);
    assert!(body["error"].as_str().unwrap().contains("402"));

    // Gateway's own auth failure is Core's problem, not the app's: it
    // stays a plain 403, and an upstream failure stays a 502.
    let (status, _) = response_json(failed(ProviderRouterError::Rejected {
        status: 401,
        body: json!({ "error": { "code": "unauthorized" } }).to_string(),
    }))
    .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = response_json(failed(ProviderRouterError::Rejected {
        status: 500,
        body: "{}".to_owned(),
    }))
    .await;
    assert_eq!(status, StatusCode::BAD_GATEWAY);
}
