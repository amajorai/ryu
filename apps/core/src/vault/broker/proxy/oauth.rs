//! OAuth service injection: the session minter's connected MCP OAuth access
//! token as `Authorization: Bearer`. The token is resolved per request and
//! never logged or echoed; refusals name the service and its status only.

use super::super::oauth::{self as broker_oauth, OAuthBinding, OAuthState, OAuthStatus};
use super::*;

/// A refusal carrying an OAuth service's status, so an agent can tell the
/// user what to reconnect or which scopes to grant.
fn status_refusal(service: &str, status: &OAuthStatus) -> Refusal {
    let (code, http, message) = match status.state {
        OAuthState::NeedsScopes => (
            "oauth_needs_scopes",
            StatusCode::FORBIDDEN,
            "the OAuth connection for this service lacks required scopes; reconnect it in Ryu and grant them",
        ),
        OAuthState::NeedsConnect => (
            "oauth_connect_required",
            StatusCode::PRECONDITION_REQUIRED,
            "connect the OAuth account for this service in Ryu first",
        ),
        OAuthState::ReauthRequired => (
            "oauth_reconnect_required",
            StatusCode::PRECONDITION_REQUIRED,
            "the OAuth connection for this service needs to be reconnected in Ryu",
        ),
        OAuthState::Unavailable | OAuthState::Connected => (
            "oauth_unavailable",
            StatusCode::SERVICE_UNAVAILABLE,
            "this node cannot use OAuth connections for brokered requests",
        ),
    };
    Refusal {
        response: json_response(
            http,
            code,
            json!({
                "error": code,
                "message": message,
                "service": service,
                "oauth": status,
            }),
        ),
        outcome: code,
    }
}

impl Broker {
    pub(super) async fn apply_oauth(
        &self,
        session: &BrokerSession,
        service: &str,
        binding: &OAuthBinding,
        outgoing: &mut Outgoing,
        action: ConnectionAction,
        force_refresh: bool,
    ) -> Result<(), Refusal> {
        let Ok(owner) = broker_oauth::owner_for_session(session.user_id()) else {
            return Err(status_refusal(
                service,
                &OAuthStatus::of(OAuthState::Unavailable),
            ));
        };
        let status = self.oauth.status(&owner, binding).await;
        if status.state != OAuthState::Connected {
            return Err(status_refusal(service, &status));
        }
        let token = self
            .oauth
            .access_token(&owner, binding, action, &session.id, force_refresh)
            .await
            .map_err(|error| {
                tracing::warn!(service, "broker oauth token fetch failed: {error:#}");
                let (status, code, message) = broker_oauth::token_failure(&error);
                Refusal::new(status, code, message)
            })?;
        outgoing.headers.insert(
            hyper::header::AUTHORIZATION,
            sensitive_value(&format!("Bearer {token}"))?,
        );
        Ok(())
    }

    /// Send an OAuth service's request; when the upstream answers `401`,
    /// refresh the token once and send the request again. A refresh that
    /// fails returns its refusal instead of the stale `401`.
    pub(super) async fn send_oauth(
        &self,
        session: &BrokerSession,
        service: &BrokerService,
        binding: &OAuthBinding,
        target: &Target,
        outgoing: Outgoing,
    ) -> Result<Response<ProxyBody>, (Refusal, bool)> {
        let retry = outgoing.clone();
        let response = self.send(target, outgoing).await?;
        if response.status() != StatusCode::UNAUTHORIZED {
            return Ok(response);
        }
        drop(response);
        let mut retry = retry;
        let action = broker_oauth::action_for_method(&retry.method);
        self.apply_oauth(session, service.name(), binding, &mut retry, action, true)
            .await
            .map_err(|refusal| (refusal, true))?;
        self.send(target, retry).await
    }
}

#[cfg(test)]
#[path = "oauth_tests.rs"]
mod tests;
