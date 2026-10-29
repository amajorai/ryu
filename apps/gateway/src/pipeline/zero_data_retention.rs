//! Validate privacy options independently of subscription plans. OpenRouter's
//! provider adapter enforces universal ZDR at its outbound boundary.

use super::RequestContext;
use crate::{error::GatewayError, state::AppState};
use serde_json::Value;

pub(super) fn enforce_requested_zdr(
    _state: &AppState,
    ctx: &RequestContext,
    body: &Value,
) -> Result<(), GatewayError> {
    let raw_zdr = body.pointer("/provider/zdr");
    let node_zdr = ctx
        .node_routing
        .as_ref()
        .and_then(|prefs| prefs.openrouter.as_ref())
        .and_then(|options| options.get("zdr"));
    for value in [raw_zdr, node_zdr].into_iter().flatten() {
        if !value.is_boolean() {
            return Err(GatewayError::BadRequest(
                "OpenRouter provider.zdr must be a boolean".to_owned(),
            ));
        }
    }
    Ok(())
}
