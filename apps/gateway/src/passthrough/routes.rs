//! The passthrough route handlers: each forwards through the active
//! [`super::PassthroughBackend`].

use std::net::SocketAddr;

use axum::{
    body::Bytes,
    extract::{ConnectInfo, Path, State},
    http::{HeaderMap, Method},
    response::Response,
};

use super::{
    classify_path,
    upstream::{anthropic_upstream, codex_upstream},
    WireFormat,
};
use crate::state::SharedState;

/// `ANY /passthrough/anthropic/{*path}` — transparent reverse proxy to Anthropic.
///
/// Pointed at by Claude Code via `ANTHROPIC_BASE_URL=<gateway>/passthrough/anthropic`;
/// the CLI appends `/v1/messages` (and `/v1/messages/count_tokens`, etc.), which
/// arrive here as `path`.
pub async fn anthropic(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(path): Path<String>,
    method: Method,
    headers: HeaderMap,
    raw_query: axum::extract::RawQuery,
    body: Bytes,
) -> Response {
    let backend = state.passthrough.active();
    backend
        .forward(
            WireFormat::Anthropic,
            anthropic_upstream(),
            classify_path(WireFormat::Anthropic, method.as_str(), &path),
            state,
            peer,
            path,
            method,
            headers,
            raw_query,
            body,
        )
        .await
}

/// `ANY /passthrough/openai-responses/{*path}` — transparent reverse proxy to the
/// OpenAI Codex backend for ChatGPT-login (subscription) accounts.
///
/// Pointed at by Codex via an isolated `CODEX_HOME` whose `config.toml` sets a
/// custom `model_provider.base_url = <gateway>/passthrough/openai-responses` with
/// `wire_api = "responses"` and no `env_key`; Codex appends `/responses` and
/// sends its OAuth bearer + `ChatGPT-Account-ID` header, which we forward
/// upstream UNCHANGED (subscription-preserving).
pub async fn codex(
    State(state): State<SharedState>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    Path(path): Path<String>,
    method: Method,
    headers: HeaderMap,
    raw_query: axum::extract::RawQuery,
    body: Bytes,
) -> Response {
    let backend = state.passthrough.active();
    backend
        .forward(
            WireFormat::OpenAiResponses,
            codex_upstream(),
            classify_path(WireFormat::OpenAiResponses, method.as_str(), &path),
            state,
            peer,
            path,
            method,
            headers,
            raw_query,
            body,
        )
        .await
}
