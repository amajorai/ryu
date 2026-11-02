//! Ryu Apps widget instances + governed widget routes (U4).
//!
//! Three responsibilities:
//! 1. [`WidgetInstanceStore`] — the authoritative, per-render identity record a
//!    minted widget carries. Minting enforces the per-session concurrency cap
//!    (D4). The MCP bridge mints at emit time; the governed routes resolve.
//! 2. `POST /api/widgets/tools/call` — the **provenance gate** (Core identity)
//!    then forward to the Gateway `POST /v1/exec/tool` which owns scan → budget →
//!    forward → audit (D5). Core never decides policy inline.
//! 3. `POST /api/widgets/follow-up` — provenance gate + firewall/DLP scan +
//!    audit, then return the provenance-tagged user turn for injection.
//! 4. `POST /api/widgets/state` — persist `widgetState` server-side (D4) so it
//!    survives reload.
//!
//! Placement (AGENTS.md §1): executing the tool / injecting a turn = Core;
//! allowlist·firewall·budget·audit = Gateway. Provenance (which widget may speak
//! for which server/session) is a Core identity gate that runs *before* the
//! Gateway policy check.
//!
//! Layout: [`instances`] holds the instance store and follow-up tickets,
//! [`tool_call`] the governed `callTool` lane, [`follow_up`] the follow-up gate,
//! [`state`] the `widgetState` route, and [`asset`] the remote-asset proxy and
//! resource read.

use axum::{http::StatusCode, response::IntoResponse, Json};
use serde::Serialize;
use serde_json::json;

mod asset;
mod follow_up;
mod instances;
mod state;
mod tool_call;

#[cfg(test)]
mod tests;

pub(crate) use asset::parse_resource_domains;
pub use asset::{__path_mcp_resources_read, mcp_resources_read, widget_asset};
pub use follow_up::{__path_widget_follow_up, widget_follow_up};
pub use instances::{
    consume_follow_up_ticket, mint_widget_instance, store, validate_follow_up_ticket,
    VerifiedWidgetProvenance, WidgetInstance,
};
pub(crate) use state::validate_widget_state;
pub use state::{__path_widget_state, widget_state};
pub use tool_call::{__path_widget_call_tool, exec_chat_tool, widget_call_tool};

/// Stable widget route error codes (D6). Keep this closed: clients branch on
/// these values, while the message remains human-readable and non-contractual.
#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum WidgetErrorCode {
    Denied,
    NotFound,
    OverBudget,
    ServerError,
    InvalidArgs,
}

impl WidgetErrorCode {
    fn from_wire(code: &str) -> Self {
        match code {
            "denied" => Self::Denied,
            "not_found" => Self::NotFound,
            "over_budget" => Self::OverBudget,
            "invalid_args" => Self::InvalidArgs,
            _ => Self::ServerError,
        }
    }
}

fn err_reply(
    status: StatusCode,
    code: &str,
    message: impl Into<String>,
) -> axum::response::Response {
    (
        status,
        Json(json!({
            "ok": false,
            "error": message.into(),
            "code": WidgetErrorCode::from_wire(code),
        })),
    )
        .into_response()
}
