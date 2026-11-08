//! Forwarding one brokered request upstream.
//! test-exempt: moved out of proxy.rs; proxy_tests.rs, proxy/oauth_tests.rs, and proxy/websocket_tests.rs drive routing and forwarding end to end.

use super::*;

/// An authorized request's service (none for an unmatched host under
/// `passthrough`), the environment's merchant-locked cards, and whether
/// only a card merchant allowlist covers the host.
pub(super) struct Route {
    pub(super) service: Option<BrokerService>,
    pub(super) cards: Vec<CardBinding>,
    pub(super) merchant_only: bool,
}

impl Broker {
    pub(super) async fn forward(
        self: &Arc<Self>,
        session: &BrokerSession,
        target: &Target,
        request: Request<Incoming>,
    ) -> Response<ProxyBody> {
        if websocket::is_upgrade(&request) {
            return self.forward_websocket(session, target, request).await;
        }
        let started = Instant::now();
        let method = request.method().clone();
        // Logged as sent: placeholders, never values, and no query string.
        let path = request.uri().path().to_owned();
        let (response, service, outcome) = match self.forward_inner(session, target, request).await
        {
            Ok((response, service)) => (response, service, "forwarded"),
            Err((refusal, service)) => (refusal.response, service, refusal.outcome),
        };
        let row = Self::log_row(
            session,
            &method,
            target,
            &path,
            service,
            response.status(),
            started,
            outcome,
        );
        self.record(row).await;
        response
    }

    pub(super) async fn forward_inner(
        &self,
        session: &BrokerSession,
        target: &Target,
        request: Request<Incoming>,
    ) -> Result<(Response<ProxyBody>, Option<String>), (Refusal, Option<String>)> {
        let Route {
            service,
            cards,
            merchant_only,
        } = self.route(session, target, request.uri().path()).await?;
        let name = service.as_ref().map(|s| s.name().to_owned());
        let fail = |refusal: Refusal| (refusal, name.clone());
        let mut outgoing = self.read_request(request).await.map_err(fail)?;
        // Service credentials first, so a failed injection never spends a
        // card approval.
        if let Some(service) = &service {
            let action = super::super::oauth::action_for_method(&outgoing.method);
            self.inject(session, service, &mut outgoing, action)
                .await
                .map_err(fail)?;
        }
        let spend = self
            .substitute_card(session, target, &cards, &mut outgoing)
            .await
            .map_err(fail)?;
        if merchant_only && spend.is_none() {
            return Err(fail(forbidden_unmatched(&target.host)));
        }
        // An OAuth service retries once with a refreshed token on a `401`;
        // never with card values in the request.
        let oauth = service
            .as_ref()
            .filter(|_| spend.is_none())
            .and_then(|service| Some((service, service.input.auth.oauth()?)));
        let sent = match oauth {
            Some((service, binding)) => {
                self.send_oauth(session, service, binding, target, outgoing)
                    .await
            }
            None => self.send(target, outgoing).await,
        };
        match sent {
            Ok(response) => Ok((response, name)),
            Err((refusal, delivered)) => {
                // Nothing reached the merchant: the approval keeps its use.
                if let (Some(spend), false) = (&spend, delivered) {
                    if let Err(error) = self
                        .store
                        .card_use_refund(&spend.request, &spend.approval_id, refusal.outcome)
                        .await
                    {
                        tracing::warn!("returning a card use failed: {error:#}");
                    }
                }
                Err(fail(refusal))
            }
        }
    }

    /// Authorize a request to `target` at `path`: rate limit, path checks,
    /// service matching, the session's service list, the scheme, and the
    /// network guard. Nothing is resolved or sent.
    pub(super) async fn route(
        &self,
        session: &BrokerSession,
        target: &Target,
        path: &str,
    ) -> Result<Route, (Refusal, Option<String>)> {
        if let Err(wait) = self.limiter.check(&session.id) {
            return Err((rate_limited(wait), None));
        }
        // The upstream URL is normalized (dot segments resolved, `%2e` and
        // `\` included) after matching, so such a path could leave the
        // matched service's prefix upstream.
        if services::has_dot_segment(path) {
            return Err((
                Refusal::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_path",
                    "paths with `.` or `..` segments (raw or percent-encoded) are not brokered",
                ),
                None,
            ));
        }
        let (services, settings, cards) = self
            .environment_view(&session.environment)
            .await
            .map_err(|refusal| (refusal, None))?;
        let merchant_host = self
            .usable_merchant(session, &cards, &target.host)
            .await
            .map_err(|refusal| (refusal, None))?;
        // Under `deny`, a host covered only by a card's merchant allowlist is
        // forwarded only when a card placeholder was actually substituted
        // (which needs HTTPS and an approval); anything else is refused like
        // any unmatched host.
        let mut merchant_only = false;
        let service = match services::match_request(&services, &target.host, target.port, path) {
            MatchOutcome::Matched(service) => Some(service.clone()),
            MatchOutcome::Disabled(service) => {
                return Err((
                    Refusal::new(
                        StatusCode::FORBIDDEN,
                        "service_disabled",
                        &format!("broker service `{}` is disabled", service.name()),
                    ),
                    Some(service.name().to_owned()),
                ))
            }
            MatchOutcome::Ambiguous(names) => {
                return Err((
                    Refusal::new(
                        StatusCode::CONFLICT,
                        "ambiguous_service",
                        &format!("equally specific services match: {}", names.join(", ")),
                    ),
                    None,
                ))
            }
            // A Box's relayed session never exits through Core's network.
            MatchOutcome::Unmatched if super::super::box_relay::is_box_session(session) => {
                return Err((forbidden_unmatched(&target.host), None))
            }
            MatchOutcome::Unmatched => match settings.unmatched_host_policy {
                UnmatchedHostPolicy::Deny if merchant_host => {
                    merchant_only = true;
                    None
                }
                UnmatchedHostPolicy::Deny => return Err((forbidden_unmatched(&target.host), None)),
                UnmatchedHostPolicy::Passthrough => None,
            },
        };
        let name = service.as_ref().map(|s| s.name().to_owned());
        let fail = |refusal: Refusal| (refusal, name.clone());
        if let Some(service) = &service {
            if !session.allows(service.name()) {
                return Err(fail(Refusal::new(
                    StatusCode::FORBIDDEN,
                    "service_not_in_session",
                    &format!(
                        "this session may not use broker service `{}`",
                        service.name()
                    ),
                )));
            }
            if target.scheme == "http" && !service.input.allow_insecure_http {
                return Err(fail(Refusal::new(
                    StatusCode::FORBIDDEN,
                    "insecure_scheme",
                    "this service only brokers https; plain http would expose the credential",
                )));
            }
        }
        // Checked before any credential is resolved; the guarded resolver
        // checks again at dial time.
        self.guard
            .resolve(&target.host, target.port)
            .await
            .map_err(|error| {
                fail(Refusal::new(
                    StatusCode::FORBIDDEN,
                    "netguard_blocked",
                    &error.to_string(),
                ))
            })?;
        Ok(Route {
            service,
            cards,
            merchant_only,
        })
    }

    pub(super) async fn read_request(
        &self,
        request: Request<Incoming>,
    ) -> Result<Outgoing, Refusal> {
        let (parts, body) = request.into_parts();
        let body = match Limited::new(body, self.config.max_request_bytes)
            .collect()
            .await
        {
            Ok(collected) => collected.to_bytes(),
            Err(error) if error.is::<http_body_util::LengthLimitError>() => {
                return Err(Refusal::new(
                    StatusCode::PAYLOAD_TOO_LARGE,
                    "request_too_large",
                    "the request body exceeds the broker limit",
                ))
            }
            Err(_) => {
                return Err(Refusal::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_body",
                    "the request body could not be read",
                ))
            }
        };
        Ok(Outgoing {
            method: parts.method,
            path: parts.uri.path().to_owned(),
            query: parts.uri.query().map(str::to_owned),
            headers: end_to_end(&parts.headers, true),
            body,
        })
    }

    /// Send upstream. A failure says whether the request may have reached
    /// the upstream (`false` only when the connection was never made).
    pub(super) async fn send(
        &self,
        target: &Target,
        outgoing: Outgoing,
    ) -> Result<Response<ProxyBody>, (Refusal, bool)> {
        let query = outgoing
            .query
            .map(|query| format!("?{query}"))
            .unwrap_or_default();
        let url = format!(
            "{}://{}:{}{}{}",
            target.scheme, target.host, target.port, outgoing.path, query
        );
        let url = reqwest::Url::parse(&url).map_err(|_| {
            (
                Refusal::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_target",
                    "invalid upstream URL",
                ),
                false,
            )
        })?;
        let upstream = self
            .client
            .request(outgoing.method, url)
            .headers(outgoing.headers)
            .body(outgoing.body)
            .send()
            .await
            .map_err(|error| {
                // The error text can echo the URL, which may now hold a
                // substituted value; report only its class.
                let class = if error.is_timeout() {
                    "timed out"
                } else if error.is_connect() {
                    "connection failed"
                } else {
                    "request failed"
                };
                (
                    Refusal::new(
                        StatusCode::BAD_GATEWAY,
                        "upstream_unreachable",
                        &format!("upstream {class}"),
                    ),
                    !error.is_connect(),
                )
            })?;
        let mut response = Response::builder().status(upstream.status());
        if let Some(headers) = response.headers_mut() {
            *headers = end_to_end(upstream.headers(), false);
        }
        let stream = upstream.bytes_stream().map(|chunk| {
            chunk
                .map(Frame::data)
                .map_err(|error| Box::new(error) as BoxError)
        });
        response
            .body(StreamBody::new(stream).boxed_unsync())
            .map_err(|_| {
                (
                    Refusal::new(
                        StatusCode::BAD_GATEWAY,
                        "upstream_invalid",
                        "invalid upstream response",
                    ),
                    true,
                )
            })
    }
}
