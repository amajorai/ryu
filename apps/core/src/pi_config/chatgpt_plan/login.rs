//! One Sign in with ChatGPT attempt: the authorization URL, then the loopback
//! callback and the code exchange.

use super::*;

pub struct LoginAttempt {
    pub(super) listener: TcpListener,
    pub(super) client: reqwest::Client,
    pub(super) endpoints: Endpoints,
    pub(super) state: String,
    pub(super) nonce: String,
    pub(super) verifier: String,
    pub(super) redirect: String,
    pub(super) host_id: String,
    pub(super) existing: Option<StoredAccount>,
    pub(super) pending_client: Option<String>,
    pub(super) enable_plan_use: bool,
}

impl LoginAttempt {
    pub async fn begin(existing: Option<StoredAccount>, enable_plan_use: bool) -> Result<Self> {
        if enable_plan_use && existing.is_none() {
            bail!("Choose a saved registration before enabling plan use");
        }
        let host_id = host_id()?;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
        let redirect = format!(
            "http://127.0.0.1:{}/auth/callback",
            listener.local_addr()?.port()
        );
        let client = http_client()?;
        let endpoints = endpoints(&client).await?;
        Ok(Self {
            listener,
            client,
            endpoints,
            state: random_value(32),
            nonce: random_value(32),
            verifier: random_value(64),
            redirect,
            host_id,
            existing,
            pending_client: None,
            enable_plan_use,
        })
    }

    pub async fn retry(client_id: String) -> Result<Self> {
        if !valid_client_id(&client_id) {
            bail!("Issued ChatGPT client ID is invalid");
        }
        let mut attempt = Self::begin(None, false).await?;
        attempt.pending_client = Some(client_id);
        Ok(attempt)
    }

    pub fn authorization_url(&self) -> Result<String> {
        let mut url = reqwest::Url::parse(&self.endpoints.authorization_endpoint)?;
        let mut query = url.query_pairs_mut();
        query.append_pair(
            "client_id",
            self.existing
                .as_ref()
                .map(StoredAccount::client_id)
                .or(self.pending_client.as_deref())
                .unwrap_or(DYNAMIC_CLIENT),
        );
        query.append_pair("ext_agent_host_id", &self.host_id);
        query
            .append_pair("response_type", "code")
            .append_pair("redirect_uri", &self.redirect)
            .append_pair("scope", SCOPES)
            .append_pair("resource", RESOURCE)
            .append_pair("state", &self.state)
            .append_pair("nonce", &self.nonce)
            .append_pair("code_challenge_method", "S256")
            .append_pair(
                "code_challenge",
                &URL_SAFE_NO_PAD.encode(Sha256::digest(self.verifier.as_bytes())),
            );
        if let Some(existing) = &self.existing {
            if let Some(hint) = existing.id_token_hint() {
                query.append_pair("id_token_hint", hint);
            }
            if let Some(email) = existing.email() {
                query.append_pair("login_hint", email);
            }
        } else if self.pending_client.is_none() {
            query.append_pair("agent_name_hint", "Ryu");
        }
        if self.enable_plan_use {
            query.append_pair("prompt", "consent");
        }
        drop(query);
        Ok(url.to_string())
    }

    pub async fn complete(self) -> Result<StoredAccount> {
        let (tx, mut rx) = oneshot::channel();
        let app = Router::new()
            .route("/auth/callback", get(callback))
            .with_state(Arc::new(CallbackState {
                expected: self.state.clone(),
                sender: Mutex::new(Some(tx)),
            }));
        let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
        let server = axum::serve(self.listener, app)
            .with_graceful_shutdown(async move {
                let _ = shutdown_rx.await;
            })
            .into_future();
        tokio::pin!(server);
        let returned = tokio::select! {
            returned = &mut rx => returned.context("ChatGPT callback was interrupted")?,
            result = &mut server => { result?; return Err(SignInFailure::CallbackStopped.into()); }
            _ = tokio::time::sleep(Duration::from_secs(15 * 60)) => return Err(SignInFailure::TimedOut.into()),
        };
        let _ = shutdown_tx.send(());
        let _ = tokio::time::timeout(Duration::from_secs(2), &mut server).await;
        if returned.error.is_some() {
            return Err(SignInFailure::Declined.into());
        }
        let client_id = match &self.existing {
            Some(existing) => {
                if returned
                    .client_id
                    .as_deref()
                    .is_some_and(|id| id != existing.client_id())
                {
                    return Err(SignInFailure::OtherAccountRegistration.into());
                }
                existing.client_id().to_owned()
            }
            None if self.pending_client.is_some() => {
                let pending = self
                    .pending_client
                    .as_deref()
                    .expect("pending registration");
                if returned
                    .client_id
                    .as_deref()
                    .is_some_and(|id| id != pending)
                {
                    return Err(SignInFailure::OtherClientRegistration.into());
                }
                pending.to_owned()
            }
            None => returned
                .client_id
                .filter(|id| valid_client_id(id))
                .context("ChatGPT registration did not return an issued client ID")?,
        };
        let code = returned
            .code
            .filter(|code| !code.is_empty() && code.len() <= 4096)
            .context("ChatGPT did not return an authorization code")?;
        let tokens: TokenResponse = response_json(
            self.client
                .post(&self.endpoints.token_endpoint)
                .form(&[
                    ("grant_type", "authorization_code"),
                    ("client_id", client_id.as_str()),
                    ("code", code.as_str()),
                    ("code_verifier", self.verifier.as_str()),
                    ("redirect_uri", self.redirect.as_str()),
                    ("resource", RESOURCE),
                ])
                .send()
                .await?,
        )
        .await
        .map_err(|error| {
            if error
                .downcast_ref::<OAuthFailure>()
                .is_some_and(|failure| failure.code == Some("invalid_grant"))
            {
                error.context(ExpiredRegistrationCode {
                    client_id: client_id.clone(),
                })
            } else {
                error
            }
        })?;
        let keys = signing_keys(&self.client, &self.endpoints).await?;
        let identity = verify_identity(
            tokens
                .id_token
                .as_deref()
                .context("ChatGPT did not return an ID token")?,
            &keys,
            &client_id,
            Some(&self.nonce),
            self.existing.as_ref().map(StoredAccount::subject),
        )?;
        credential(tokens, identity, client_id, self.host_id, None, None)
    }
}
