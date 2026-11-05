//! `CONNECT` handling: interception, raw tunnels, and intercepted TLS.

use super::*;

impl Broker {
    // ── CONNECT ───────────────────────────────────────────────────────────

    pub(super) async fn connect(
        self: Arc<Self>,
        session: BrokerSession,
        request: Request<Incoming>,
    ) -> Response<ProxyBody> {
        let started = Instant::now();
        let Some(authority) = request.uri().authority() else {
            return error_response(
                StatusCode::BAD_REQUEST,
                "invalid_connect",
                "CONNECT needs host:port",
            );
        };
        let target = Target {
            scheme: "https",
            host: authority.host().to_ascii_lowercase(),
            port: authority.port_u16().unwrap_or(443),
        };
        let opened = match self.limiter.check(&session.id) {
            Err(wait) => Err(rate_limited(wait)),
            Ok(()) => self.clone().open_tunnel(&session, &target, request).await,
        };
        let (response, outcome) = match opened {
            Ok(outcome) => (Response::new(empty()), outcome),
            Err(refusal) => (refusal.response, refusal.outcome),
        };
        let row = Self::log_row(
            &session,
            &Method::CONNECT,
            &target,
            "",
            None,
            response.status(),
            started,
            outcome,
        );
        self.record(row).await;
        response
    }

    /// Decide how to handle a CONNECT and start the tunnel task. The client
    /// gets `200` only after the decision.
    pub(super) async fn open_tunnel(
        self: Arc<Self>,
        session: &BrokerSession,
        target: &Target,
        request: Request<Incoming>,
    ) -> Result<&'static str, Refusal> {
        let (services, settings, cards) = self.environment_view(&session.environment).await?;
        // A merchant host of a card this session may use is intercepted too,
        // so card placeholders can be substituted there.
        let brokered = services::host_is_brokered(&services, &target.host, target.port)
            || self.usable_merchant(session, &cards, &target.host).await?;
        if !brokered && settings.unmatched_host_policy == UnmatchedHostPolicy::Deny {
            return Err(forbidden_unmatched(&target.host));
        }
        let permit = self.acquire_tunnel(&session.id).ok_or_else(|| {
            Refusal::new(
                StatusCode::TOO_MANY_REQUESTS,
                "too_many_tunnels",
                "the broker session has too many open tunnels",
            )
        })?;
        if !brokered {
            let addrs = self
                .guard
                .resolve(&target.host, target.port)
                .await
                .map_err(|error| {
                    Refusal::new(
                        StatusCode::FORBIDDEN,
                        "netguard_blocked",
                        &error.to_string(),
                    )
                })?;
            let broker = self.clone();
            let session = session.clone();
            tokio::spawn(async move { broker.raw_tunnel(request, addrs, session, permit).await });
            return Ok("tunneled");
        }
        let leaves = self.leaf_cache().await.map_err(|error| {
            let sealed = error
                .downcast_ref::<VaultError>()
                .is_some_and(|e| matches!(e, VaultError::Sealed));
            tracing::warn!("broker CA unavailable: {error:#}");
            if sealed {
                Refusal::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "vault_sealed",
                    "the vault is sealed",
                )
            } else {
                Refusal::new(
                    StatusCode::SERVICE_UNAVAILABLE,
                    "broker_ca_unavailable",
                    "the broker CA is unavailable",
                )
            }
        })?;
        let leaf = leaves.leaf(&target.host).map_err(|_| {
            Refusal::new(
                StatusCode::BAD_REQUEST,
                "invalid_connect",
                "invalid CONNECT host",
            )
        })?;
        let broker = self.clone();
        let session = session.clone();
        let target = target.clone();
        tokio::spawn(async move {
            let _permit = permit;
            match hyper::upgrade::on(request).await {
                Ok(upgraded) => {
                    broker
                        .serve_intercepted(upgraded, leaf, session, target)
                        .await
                }
                Err(error) => tracing::debug!("broker CONNECT upgrade failed: {error}"),
            }
        });
        Ok("intercepted")
    }

    /// A raw (passthrough) tunnel, closed when its session ends.
    pub(super) async fn raw_tunnel(
        self: Arc<Self>,
        request: Request<Incoming>,
        addrs: Vec<SocketAddr>,
        session: BrokerSession,
        _permit: TunnelPermit,
    ) {
        let upgraded = match hyper::upgrade::on(request).await {
            Ok(upgraded) => upgraded,
            Err(error) => {
                tracing::debug!("broker tunnel upgrade failed: {error}");
                return;
            }
        };
        let mut upstream = match TcpStream::connect(&addrs[..]).await {
            Ok(stream) => stream,
            Err(error) => {
                tracing::debug!("broker tunnel connect failed: {error}");
                return;
            }
        };
        // Nagle + delayed ACK would stall each small relayed write ~40 ms.
        if let Err(error) = upstream.set_nodelay(true) {
            tracing::debug!("broker tunnel could not set TCP_NODELAY: {error}");
        }
        let mut client = TokioIo::new(upgraded);
        tokio::select! {
            _ = tokio::io::copy_bidirectional(&mut client, &mut upstream) => {}
            () = self.session_ended(&session.id, session.expires_at) => {
                tracing::debug!(session = session.id, "closing broker tunnel: session ended");
            }
        }
    }

    pub(super) async fn serve_intercepted(
        self: Arc<Self>,
        upgraded: hyper::upgrade::Upgraded,
        leaf: Arc<CertifiedKey>,
        session: BrokerSession,
        target: Target,
    ) {
        let config = match rustls::ServerConfig::builder_with_provider(self.provider.clone())
            .with_safe_default_protocol_versions()
        {
            Ok(builder) => {
                let mut config = builder
                    .with_no_client_auth()
                    .with_cert_resolver(Arc::new(FixedCert(leaf)));
                config.alpn_protocols = vec![b"http/1.1".to_vec()];
                config
            }
            Err(error) => {
                tracing::warn!("broker TLS config failed: {error}");
                return;
            }
        };
        let acceptor = tokio_rustls::TlsAcceptor::from(Arc::new(config));
        let tls = match acceptor.accept(TokioIo::new(upgraded)).await {
            Ok(tls) => tls,
            Err(error) => {
                tracing::debug!(host = target.host, "broker TLS handshake failed: {error}");
                return;
            }
        };
        let session_id: Arc<str> = Arc::from(session.id.as_str());
        let target = Arc::new(target);
        let broker = self.clone();
        let id = session_id.clone();
        // The CONNECT authenticated the session once; every request on the
        // kept-alive connection re-checks it, so a revoked or expired session
        // gets no further credentials.
        let service = service_fn(move |request: Request<Incoming>| {
            let broker = broker.clone();
            let id = id.clone();
            let target = target.clone();
            async move {
                let Some(session) = broker.live_session(&id).await else {
                    return Ok::<_, Infallible>(proxy_auth_required());
                };
                Ok(broker.forward(&session, &target, request).await)
            }
        });
        let connection =
            hyper::server::conn::http1::Builder::new().serve_connection(TokioIo::new(tls), service);
        tokio::select! {
            result = connection => {
                if let Err(error) = result {
                    tracing::debug!("broker intercepted connection ended: {error}");
                }
            }
            () = self.session_ended(&session_id, session.expires_at) => {
                tracing::debug!(session = &*session_id, "closing intercepted tunnel: session ended");
            }
        }
    }
}
