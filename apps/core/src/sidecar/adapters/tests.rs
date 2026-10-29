use super::*;
use crate::server::memory::DEFAULT_LONG_TERM_LIMIT;
use crate::sidecar::adapters::acp_spawn::AcpSpawn;
use agent_client_protocol::schema::v1::McpServer;
use std::str::FromStr;

mod auto_recall;
mod engine_bindings;
mod flagship_routing;
mod gateway_fallback;
mod inference_stats;
mod late_tool_arguments;
mod limited_agents;
mod output_styles;
mod parts_accumulator;
mod plan_mode;
mod preamble_layers;
mod reply_text;
mod request_shape_goldens;
mod route_reach_and_launch_check;
mod sdk_app_routing;
mod streaming_timeouts;
mod team_drain;
mod tool_call_normalization;
mod tool_call_timing;
mod turn_setup;

fn acp_reg() -> AcpAgentRegistry {
    AcpAgentRegistry::new()
}

fn provider_reg() -> ProviderRegistry {
    ProviderRegistry::default()
}

/// Route `engine` as the limited agent `id` with the given provider access.
fn limited_route(id: &str, engine: &str, access: Option<&[String]>) -> Option<AgentRoute> {
    agent_route_with_user_jwt(
        Some(id),
        Some(engine),
        None,
        &acp_reg(),
        &provider_reg(),
        None,
        None,
        None,
        None,
        access,
    )
}

/// Decode one `data: {json}\n\n` SSE frame back into its value.
fn decode_frame(bytes: Vec<u8>) -> Value {
    let text = String::from_utf8(bytes).expect("frame is utf-8");
    let body = text
        .strip_prefix("data: ")
        .and_then(|s| s.strip_suffix("\n\n"))
        .expect("frame is a single SSE data line");
    serde_json::from_str(body).expect("frame body is json")
}
