//! Error responses for the workspace handoff routes and the blocking-task bridge.

use super::*;

/// `{ error, code }`: the code is the stable, machine-readable part.
pub(super) fn coded_error(status: StatusCode, code: &str, message: impl Into<String>) -> Response {
    (
        status,
        Json(json!({ "error": message.into(), "code": code })),
    )
        .into_response()
}

pub(super) fn validation_response(error: ValidationError) -> Response {
    let code = if error.status == StatusCode::PAYLOAD_TOO_LARGE {
        "too-large"
    } else {
        "invalid-manifest"
    };
    coded_error(error.status, code, error.message)
}

pub(super) fn handoff_response(error: HandoffError) -> Response {
    let (status, code) = match &error {
        HandoffError::NotAGitRepository => {
            (StatusCode::UNPROCESSABLE_ENTITY, "not-a-git-repository")
        }
        HandoffError::HeadMoved { .. } => (StatusCode::CONFLICT, "head-moved"),
        HandoffError::TooLarge(_) => (StatusCode::PAYLOAD_TOO_LARGE, "too-large"),
        HandoffError::Refused(_) => (StatusCode::UNPROCESSABLE_ENTITY, "refused"),
        HandoffError::MissingCommit(_) => (StatusCode::CONFLICT, "missing-commit"),
        HandoffError::Git(_) => (StatusCode::BAD_GATEWAY, "git-failed"),
    };
    coded_error(status, code, error.to_string())
}

pub(super) async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, HandoffError> + Send + 'static,
) -> Result<T, Response> {
    match tokio::task::spawn_blocking(work).await {
        Ok(result) => result.map_err(handoff_response),
        Err(error) => {
            tracing::error!("rnp workspace task failed: {error}");
            Err(coded_error(
                StatusCode::INTERNAL_SERVER_ERROR,
                "internal",
                "internal error",
            ))
        }
    }
}
