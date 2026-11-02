//! The loopback page the browser lands on after Sign in with ChatGPT.
//!
//! No client localizer runs in that browser tab, so Core renders the page in
//! the user's language itself: the language fixed in the node's `ui-language`
//! preference, else the browser's `Accept-Language`, else the node's locale
//! (the same order as the MCP OAuth callback page).

use super::*;
use crate::i18n::messages::{
    LOGIN_CHATGPT_CALLBACK_RECEIVED_MESSAGE, LOGIN_CHATGPT_CALLBACK_TITLE_MESSAGE,
    LOGIN_CHATGPT_CALLBACK_UNAVAILABLE_MESSAGE, LOGIN_CHATGPT_CALLBACK_UNVERIFIED_MESSAGE,
    LOGIN_CHATGPT_CALLBACK_USED_MESSAGE,
};
use crate::i18n::{locale, Message, Template};
use axum::{
    http::{header, HeaderMap, HeaderValue},
    response::{Html, IntoResponse, Response},
};
use ryu_vault::mcp_oauth::{render_callback_page, CallbackPageCopy};

#[derive(Deserialize)]
pub(super) struct Callback {
    pub(super) state: Option<String>,
    pub(super) code: Option<String>,
    pub(super) client_id: Option<String>,
    pub(super) error: Option<String>,
}

pub(super) struct CallbackState {
    pub(super) expected: String,
    pub(super) sender: Mutex<Option<oneshot::Sender<Callback>>>,
}

/// What the callback did with the browser's redirect.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(super) enum CallbackOutcome {
    Received,
    Unverified,
    Unavailable,
    AlreadyUsed,
}

impl CallbackOutcome {
    pub(super) fn status(self) -> StatusCode {
        match self {
            Self::Received => StatusCode::OK,
            Self::Unverified => StatusCode::BAD_REQUEST,
            Self::Unavailable => StatusCode::INTERNAL_SERVER_ERROR,
            Self::AlreadyUsed => StatusCode::GONE,
        }
    }

    fn detail(self) -> Template {
        match self {
            Self::Received => LOGIN_CHATGPT_CALLBACK_RECEIVED_MESSAGE,
            Self::Unverified => LOGIN_CHATGPT_CALLBACK_UNVERIFIED_MESSAGE,
            Self::Unavailable => LOGIN_CHATGPT_CALLBACK_UNAVAILABLE_MESSAGE,
            Self::AlreadyUsed => LOGIN_CHATGPT_CALLBACK_USED_MESSAGE,
        }
    }
}

/// Hand a redirect carrying the expected state to the waiting attempt, once.
pub(super) fn accept(state: &CallbackState, query: Callback) -> CallbackOutcome {
    if query.state.as_deref() != Some(state.expected.as_str()) {
        return CallbackOutcome::Unverified;
    }
    let Ok(mut sender) = state.sender.lock() else {
        return CallbackOutcome::Unavailable;
    };
    let Some(sender) = sender.take() else {
        return CallbackOutcome::AlreadyUsed;
    };
    let _ = sender.send(query);
    CallbackOutcome::Received
}

pub(super) async fn callback(
    State(state): State<Arc<CallbackState>>,
    headers: HeaderMap,
    Query(query): Query<Callback>,
) -> Response {
    let outcome = accept(&state, query);
    let accept_language = headers
        .get(header::ACCEPT_LANGUAGE)
        .and_then(|value| value.to_str().ok());
    let locale = match locale::fixed_node_locale().await {
        Some(locale) => locale,
        None => match accept_language.and_then(locale::from_accept_language) {
            Some(locale) => locale,
            None => locale::node_locale().await,
        },
    };
    callback_page(outcome, locale)
}

/// The callback page for `outcome` in `locale`, with the outcome's status.
pub(super) fn callback_page(outcome: CallbackOutcome, locale: &'static str) -> Response {
    let copy = CallbackPageCopy {
        lang: locale.to_owned(),
        dir: locale::text_direction(locale).to_owned(),
        title: Message::new(LOGIN_CHATGPT_CALLBACK_TITLE_MESSAGE).render(locale),
        detail: Message::new(outcome.detail()).render(locale),
    };
    let content_language =
        HeaderValue::from_str(&copy.lang).unwrap_or(HeaderValue::from_static("en"));
    (
        outcome.status(),
        [
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (
                header::REFERRER_POLICY,
                HeaderValue::from_static("no-referrer"),
            ),
            (
                header::X_CONTENT_TYPE_OPTIONS,
                HeaderValue::from_static("nosniff"),
            ),
            (header::CONTENT_LANGUAGE, content_language),
        ],
        Html(render_callback_page(&copy)),
    )
        .into_response()
}
