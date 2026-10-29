use super::*;

// ── SDK app routing (issue #208) ─────────────────────────────────────────

#[test]
fn sdk_app_agent_id_resolves_to_sdk_app_route() {
    // An `sdk:*` agent_id must resolve to an SdkApp route so Core can route
    // chat to the loopback OpenAI-compat endpoint the SDK process serves on.
    let route = agent_route(
        Some("sdk:my-sdk-app"),
        Some("sdk:my-sdk-app"),
        None,
        &acp_reg(),
        &provider_reg(),
    )
    .expect("sdk app route");
    assert!(
        matches!(route, AgentRoute::SdkApp { .. }),
        "sdk:* agent_id must resolve to SdkApp route"
    );
}

#[test]
fn sdk_app_route_base_url_is_loopback() {
    // The Core→SDK-app hop must target the loopback (not the gateway), so
    // model calls routed from Core hit the SDK process's local server. Gateway
    // policy flows via env-injection into the SDK subprocess at spawn time.
    let route = agent_route(
        Some("sdk:my-sdk-app"),
        Some("sdk:my-sdk-app"),
        None,
        &acp_reg(),
        &provider_reg(),
    )
    .expect("sdk app route");
    match route {
        AgentRoute::SdkApp { base_url, .. } => {
            assert!(
                base_url.starts_with("http://127.0.0.1:"),
                "SDK app base_url must be loopback, got: {base_url}"
            );
            let gateway_url = crate::sidecar::gateway::gateway_url();
            assert_ne!(
                base_url, gateway_url,
                "SDK app route must not target the gateway directly"
            );
        }
        _ => panic!("expected SdkApp route"),
    }
}

#[test]
fn sdk_app_route_uses_via_gateway_false() {
    // SdkApp is not an OpenAiCompat route at the Core hop — it is its own
    // variant, so the via_gateway flag does not apply here. This test asserts
    // the route does NOT accidentally end up as OpenAiCompat via_gateway:true,
    // which would loop Core→gateway→Core.
    let route = agent_route(
        Some("sdk:my-sdk-app"),
        Some("sdk:my-sdk-app"),
        None,
        &acp_reg(),
        &provider_reg(),
    )
    .expect("sdk app route");
    assert!(
        !matches!(
            route,
            AgentRoute::OpenAiCompat {
                via_gateway: true,
                ..
            }
        ),
        "SDK app must not be OpenAiCompat via_gateway:true"
    );
}
