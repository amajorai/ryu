//! Owner confirmation for hosted MCP OAuth callbacks.
//!
//! The public hosted callback is reached by whichever browser opens the
//! authorization URL, and the OAuth `state` in that forwardable URL is all that
//! ties the response to a flow. The callback therefore only exchanges the code
//! and shows a one-time confirmation code; the tokens are stored when the
//! verified caller who started the flow posts that code here.

use axum::{
    extract::Path,
    http::StatusCode,
    response::{IntoResponse, Response},
    Extension, Json,
};
use ryu_vault::mcp_oauth::CallbackPageCopy;
use serde::Deserialize;
use serde_json::json;

use super::mcp_oauth_api::{error, owner};
use crate::i18n::{locale, messages, Message};
use crate::identity_verify::VerifiedCaller;

/// Longest code accepted; real codes are `XXXX-XXXX`.
const MAX_CODE_LEN: usize = 64;

/// The callback page's language: the user's fixed app language, else the
/// browser's `Accept-Language`, else the node's locale.
pub(super) async fn callback_locale(accept_language: Option<String>) -> &'static str {
    match locale::fixed_node_locale().await {
        Some(locale) => locale,
        None => match accept_language
            .as_deref()
            .and_then(locale::from_accept_language)
        {
            Some(locale) => locale,
            None => locale::node_locale().await,
        },
    }
}

/// Copy for the page that shows the confirmation code.
pub(super) async fn confirmation_page_copy(accept_language: Option<String>) -> CallbackPageCopy {
    confirmation_page_copy_for(callback_locale(accept_language).await)
}

fn confirmation_page_copy_for(locale: &'static str) -> CallbackPageCopy {
    CallbackPageCopy {
        lang: locale.to_owned(),
        dir: locale::text_direction(locale).to_owned(),
        title: Message::new(messages::OAUTH_CONFIRM_TITLE_MESSAGE).render(locale),
        detail: Message::new(messages::OAUTH_CONFIRM_DETAIL_MESSAGE).render(locale),
    }
}

// The code the hosted callback page showed, e.g. `ABCD-EFGH`.
#[derive(Debug, Deserialize, utoipa::ToSchema)]
pub struct ConfirmFlowBody {
    code: String,
}

/// Save a hosted MCP OAuth connection for the caller who started it, using the code its callback page showed.
#[utoipa::path(
    post,
    path = "/api/plugins/{plugin_id}/auth/flows/{flow_id}/confirm",
    tag = "Plugins",
    params(("plugin_id" = String, Path), ("flow_id" = String, Path)),
    request_body = ConfirmFlowBody,
    responses((status = 200, description = "Connection saved; the flow is connected", body = crate::mcp_oauth::FlowView))
)]
pub async fn confirm_flow(
    Path((plugin_id, flow_id)): Path<(String, String)>,
    Extension(caller): Extension<Option<VerifiedCaller>>,
    Json(body): Json<ConfirmFlowBody>,
) -> Response {
    let owner_user_id = match owner(caller.as_ref()) {
        Ok(owner) => owner,
        Err(response) => return response,
    };
    if body.code.is_empty() || body.code.len() > MAX_CODE_LEN {
        return error(StatusCode::BAD_REQUEST, "confirmation code is required");
    }
    let manager = crate::mcp_oauth::global();
    match manager.flow(&owner_user_id, &flow_id).await {
        Ok(flow) if flow.plugin_id == plugin_id => {}
        _ => return error(StatusCode::NOT_FOUND, "OAuth flow not found"),
    }
    if let Err(message) = manager
        .confirm_hosted_flow(&owner_user_id, &flow_id, &body.code)
        .await
    {
        return error(StatusCode::BAD_REQUEST, message);
    }
    match manager.flow(&owner_user_id, &flow_id).await {
        Ok(flow) => (StatusCode::OK, Json(json!(flow))).into_response(),
        Err(message) => error(StatusCode::NOT_FOUND, message),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::http::header;
    use ryu_vault::mcp_oauth::render_confirmation_page;

    #[tokio::test]
    async fn the_confirmation_page_shows_the_code_and_the_warning() {
        let copy = confirmation_page_copy_for("en");
        let response = super::super::mcp_oauth_api::callback_html_response(
            StatusCode::OK,
            &copy,
            render_confirmation_page(&copy, "ABCD-EFGH"),
        );
        assert_eq!(response.headers()[header::CACHE_CONTROL], "no-store");
        let bytes = axum::body::to_bytes(response.into_body(), usize::MAX)
            .await
            .unwrap();
        let body = String::from_utf8(bytes.to_vec()).unwrap();
        assert!(body.contains(">ABCD-EFGH</code>"), "{body}");
        assert!(body.contains("<h1>Enter this code in Ryu to finish</h1>"));
        assert!(body.contains("If someone sent you this sign-in link"));
    }

    #[test]
    fn the_confirmation_copy_follows_the_locale_direction() {
        let arabic = confirmation_page_copy_for("ar");
        assert_eq!((arabic.lang.as_str(), arabic.dir.as_str()), ("ar", "rtl"));
    }

    #[test]
    fn the_confirm_body_requires_a_code() {
        assert!(serde_json::from_value::<ConfirmFlowBody>(json!({"code":"ABCD-EFGH"})).is_ok());
        assert!(serde_json::from_value::<ConfirmFlowBody>(json!({})).is_err());
    }
}
