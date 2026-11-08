//! The listener: binding, connection serving, session checks, and the request log.
//! test-exempt: moved out of proxy.rs; every proxy_tests.rs case binds and serves through it.

use super::super::box_relay;
use super::*;

/// How a connection's requests are authenticated.
enum Admission {
    /// The loopback listener: each request's `Proxy-Authorization`.
    Direct(SocketAddr),
    /// A Box's relay: the one session the relay admitted.
    Relayed(String),
}

impl Broker {
    /// Bind the loopback listener and build the upstream client.
    pub async fn bind(
        store: &'static PluginSecretStore,
        config: BrokerConfig,
    ) -> Result<(Arc<Self>, TcpListener)> {
        Self::bind_with_oauth(
            store,
            config,
            Arc::new(super::super::oauth::CoreOAuthTokens),
        )
        .await
    }

    /// [`Broker::bind`] with an explicit OAuth token source.
    pub async fn bind_with_oauth(
        store: &'static PluginSecretStore,
        config: BrokerConfig,
        oauth: Arc<dyn OAuthTokens>,
    ) -> Result<(Arc<Self>, TcpListener)> {
        let listener = TcpListener::bind(("127.0.0.1", config.port))
            .await
            .with_context(|| format!("binding the broker on 127.0.0.1:{}", config.port))?;
        let port = listener.local_addr()?.port();
        let guard = Arc::new(config.guard.clone());
        let mut builder = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .dns_resolver(Arc::new(GuardedResolver(guard.clone())))
            .no_gzip()
            .no_brotli()
            .no_deflate()
            .no_zstd()
            .connect_timeout(Duration::from_secs(15))
            .read_timeout(Duration::from_secs(300));
        for pem in &config.extra_upstream_roots_pem {
            builder = builder.add_root_certificate(
                reqwest::Certificate::from_pem(pem.as_bytes())
                    .context("parsing an extra upstream root")?,
            );
        }
        let broker = Self {
            store,
            port,
            guard,
            limiter: RateLimiter::new(config.rps, config.burst),
            client: builder
                .build()
                .context("building the broker upstream client")?,
            provider: Arc::new(rustls::crypto::ring::default_provider()),
            leaves: tokio::sync::Mutex::new(None),
            tunnels: std::sync::Mutex::new(HashMap::new()),
            oauth,
            config,
        };
        Ok((Arc::new(broker), listener))
    }

    pub fn port(&self) -> u16 {
        self.port
    }

    /// Accept connections until the listener fails.
    pub async fn serve(self: Arc<Self>, listener: TcpListener) {
        loop {
            let (stream, peer) = match listener.accept().await {
                Ok(accepted) => accepted,
                Err(error) => {
                    tracing::warn!("broker accept failed: {error}");
                    tokio::time::sleep(Duration::from_millis(100)).await;
                    continue;
                }
            };
            // Nagle + delayed ACK would stall each small relayed write ~40 ms.
            if let Err(error) = stream.set_nodelay(true) {
                tracing::debug!("broker could not set TCP_NODELAY: {error}");
            }
            let broker = self.clone();
            tokio::spawn(async move { broker.serve_connection(stream, peer).await });
        }
    }

    pub(super) async fn serve_connection(self: Arc<Self>, stream: TcpStream, peer: SocketAddr) {
        self.serve_io(stream, Admission::Direct(peer)).await;
    }

    /// Serve one Box's relayed proxy connection ([`super::super::box_relay`]):
    /// every request runs as the Box's session `session_id`, re-checked live
    /// per request, and `Proxy-Authorization` in the stream is ignored.
    pub async fn serve_relayed<I>(self: Arc<Self>, io: I, session_id: String)
    where
        I: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        self.serve_io(io, Admission::Relayed(session_id)).await;
    }

    async fn serve_io<I>(self: Arc<Self>, io: I, admission: Admission)
    where
        I: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin + Send + 'static,
    {
        let broker = self.clone();
        let admission = Arc::new(admission);
        let service = service_fn(move |request: Request<Incoming>| {
            let broker = broker.clone();
            let admission = admission.clone();
            async move {
                let response = match admission.as_ref() {
                    Admission::Direct(peer) => broker.handle(request, *peer).await,
                    Admission::Relayed(id) => broker.handle_relayed(request, id).await,
                };
                Ok::<_, Infallible>(response)
            }
        });
        if let Err(error) = hyper::server::conn::http1::Builder::new()
            .serve_connection(TokioIo::new(io), service)
            .with_upgrades()
            .await
        {
            tracing::debug!("broker connection ended: {error}");
        }
    }

    pub(super) async fn handle(
        self: Arc<Self>,
        request: Request<Incoming>,
        peer: SocketAddr,
    ) -> Response<ProxyBody> {
        let session = match self.authenticate(request.headers(), peer).await {
            Ok(session) => session,
            Err(response) => return response,
        };
        // A Box's session works only through its relay, never on loopback.
        if box_relay::is_box_session(&session) {
            return proxy_auth_required();
        }
        self.dispatch(session, request).await
    }

    /// A relayed request: the bound session, if it is still a live Box session.
    async fn handle_relayed(
        self: Arc<Self>,
        request: Request<Incoming>,
        session_id: &str,
    ) -> Response<ProxyBody> {
        match self.live_session(session_id).await {
            Some(session) if box_relay::is_box_session(&session) => {
                self.dispatch(session, request).await
            }
            _ => proxy_auth_required(),
        }
    }

    async fn dispatch(
        self: Arc<Self>,
        session: BrokerSession,
        request: Request<Incoming>,
    ) -> Response<ProxyBody> {
        if request.method() == Method::CONNECT {
            return self.connect(session, request).await;
        }
        let uri = request.uri();
        let (Some(scheme), Some(host)) = (uri.scheme_str(), uri.host()) else {
            return error_response(
                StatusCode::BAD_REQUEST,
                "absolute_form_required",
                "send absolute-form requests (http://host/path) or CONNECT",
            );
        };
        let target = match scheme {
            "http" => Target {
                scheme: "http",
                host: host.to_ascii_lowercase(),
                port: uri.port_u16().unwrap_or(80),
            },
            "https" => Target {
                scheme: "https",
                host: host.to_ascii_lowercase(),
                port: uri.port_u16().unwrap_or(443),
            },
            _ => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "unsupported_scheme",
                    "only http and https are brokered",
                )
            }
        };
        self.forward(&session, &target, request).await
    }

    /// The live session named by `Proxy-Authorization`, presented from
    /// `peer` (a machine-minted session keeps its token's CIDR binding).
    pub(super) async fn authenticate(
        &self,
        headers: &HeaderMap,
        peer: SocketAddr,
    ) -> Result<BrokerSession, Response<ProxyBody>> {
        let Some(token) = headers
            .get(hyper::header::PROXY_AUTHORIZATION)
            .and_then(|value| value.to_str().ok())
            .and_then(sessions::parse_authorization)
        else {
            return Err(proxy_auth_required());
        };
        let conn = self.store.conn.lock().await;
        match sessions::lookup(&conn, &token, Some(peer.ip())) {
            Ok(Some(session)) => Ok(session),
            Ok(None) => Err(proxy_auth_required()),
            Err(error) => {
                tracing::warn!("broker session lookup failed: {error:#}");
                Err(error_response(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "broker_internal",
                    "session lookup failed",
                ))
            }
        }
    }

    /// The environment's services, settings, and merchant-locked cards.
    pub(super) async fn environment_view(
        &self,
        environment: &str,
    ) -> Result<(Vec<BrokerService>, EnvironmentSettings, Vec<CardBinding>), Refusal> {
        let conn = self.store.conn.lock().await;
        let view = services::list(&conn, Some(environment)).and_then(|services| {
            Ok((
                services,
                settings::get(&conn, environment)?,
                cards::bindings_locked(&conn, environment)?,
            ))
        });
        view.map_err(|error| {
            tracing::warn!("broker could not read services: {error:#}");
            Refusal::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "broker_internal",
                "service lookup failed",
            )
        })
    }

    /// The leaf issuer. A sealed vault drops the cached (unsealed) CA key
    /// and refuses, so sealing stops interception immediately; the next use
    /// after unsealing reloads the key through the keyring.
    pub(super) async fn leaf_cache(&self) -> Result<Arc<LeafCache>> {
        let mut cached = self.leaves.lock().await;
        if self.store.keyring.is_sealed() {
            *cached = None;
            return Err(VaultError::Sealed.into());
        }
        if let Some(cache) = cached.as_ref() {
            return Ok(cache.clone());
        }
        let material = ca::ensure(self.store).await?;
        let cache = Arc::new(LeafCache::new(&material, self.provider.clone())?);
        *cached = Some(cache.clone());
        Ok(cache)
    }

    /// The session with this id if it is still live.
    pub(super) async fn live_session(&self, id: &str) -> Option<BrokerSession> {
        let conn = self.store.conn.lock().await;
        match sessions::live(&conn, id) {
            Ok(session) => session,
            Err(error) => {
                tracing::warn!("broker session re-check failed: {error:#}");
                None
            }
        }
    }

    /// Completes once the session is no longer live (revoked, expired, or its
    /// minting token revoked), checking every `session_check_interval`.
    pub(super) async fn session_ended(&self, id: &str, expires_at: i64) {
        loop {
            let remaining = expires_at.saturating_sub(now_millis());
            if remaining <= 0 {
                return;
            }
            let until_expiry = Duration::from_millis(u64::try_from(remaining).unwrap_or(u64::MAX));
            tokio::time::sleep(self.config.session_check_interval.min(until_expiry)).await;
            if self.live_session(id).await.is_none() {
                return;
            }
        }
    }

    /// Count a tunnel against its session, or `None` at the cap.
    pub(super) fn acquire_tunnel(self: &Arc<Self>, session_id: &str) -> Option<TunnelPermit> {
        let mut tunnels = self.tunnels.lock().ok()?;
        let count = tunnels.entry(session_id.to_owned()).or_insert(0);
        if *count >= self.config.max_tunnels_per_session {
            return None;
        }
        *count += 1;
        Some(TunnelPermit {
            broker: self.clone(),
            session_id: session_id.to_owned(),
        })
    }

    pub(super) async fn record(&self, row: LogRow) {
        let conn = self.store.conn.lock().await;
        if let Err(error) = log::insert(&conn, &row) {
            tracing::warn!("broker log write failed: {error:#}");
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub(super) fn log_row(
        session: &BrokerSession,
        method: &Method,
        target: &Target,
        path: &str,
        service: Option<String>,
        status: StatusCode,
        started: Instant,
        outcome: &str,
    ) -> LogRow {
        LogRow {
            id: 0,
            at: now_millis(),
            session_id: Some(session.id.clone()),
            environment: session.environment.clone(),
            method: method.to_string(),
            scheme: target.scheme.to_owned(),
            host: target.host.clone(),
            port: target.port,
            path: path.to_owned(),
            service,
            status: status.as_u16(),
            latency_ms: started.elapsed().as_millis() as i64,
            outcome: outcome.to_owned(),
        }
    }
}
