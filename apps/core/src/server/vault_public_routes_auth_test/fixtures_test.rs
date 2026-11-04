use super::*;

/// Every public route that authenticates with a presented token. Logins, the
/// wrapping routes and the routes public by design are listed separately.
pub(super) const ROUTES: &[Route] = &[
    route!(Agent, "GET", "/api/vault/agent/self"),
    route!(Agent, "GET", "/api/vault/agent/events"),
    route!(Agent, "POST", "/api/vault/agent/self/revoke"),
    route!(Agent, "POST", "/api/vault/agent/export", "{}"),
    route!(Agent, "GET", "/api/vault/agent/secrets/PUBAUTH_SECRET"),
    route!(Agent, "POST", "/api/vault/agent/dynamic/:role", "{}"),
    route!(Agent, "POST", "/api/vault/agent/leases/:id/:op", "{}"),
    route!(Agent, "POST", "/api/vault/agent/transit/:op/:name", "{}"),
    route!(
        Agent,
        "POST",
        "/api/vault/agent/pki/:op/:role",
        r#"{"commonName":"host.pubauth.test"}"#
    ),
    route!(
        Agent,
        "POST",
        "/api/vault/agent/ssh/sign/:role",
        r#"{"publicKey":"ssh-ed25519 AAAA"}"#
    ),
    route!(Agent, "GET", "/api/vault/agent/totp/code/:name"),
    route!(
        Agent,
        "POST",
        "/api/vault/agent/totp/validate/:name",
        r#"{"code":"123456"}"#
    ),
    route!(
        Agent,
        "GET",
        "/api/vault/agent/password-policies/:name/generate"
    ),
    route!(Agent, "POST", "/api/vault/agent/identity/token/:role"),
    route!(Agent, "GET", "/api/vault/agent/self/lookup"),
    route!(Agent, "POST", "/api/vault/agent/self/renew", "{}"),
    route!(Agent, "POST", "/api/vault/agent/self/child", "{}"),
    route!(
        Agent,
        "POST",
        "/api/vault/agent/wrapping/wrap",
        r#"{"k":"v"}"#
    ),
    route!(Agent, "GET", "/api/vault/agent/cubbyhole"),
    route!(Agent, "GET", "/api/vault/agent/cubbyhole/:key"),
    route!(
        Agent,
        "PUT",
        "/api/vault/agent/cubbyhole/:key",
        r#"{"v":1}"#
    ),
    route!(Agent, "DELETE", "/api/vault/agent/cubbyhole/:key"),
    route!(
        Broker,
        "POST",
        "/api/vault/agent/broker/sessions",
        r#"{"services":["openai"],"label":"pubauth"}"#
    ),
    route!(Broker, "GET", "/api/vault/agent/broker/discover"),
    route!(Broker, "POST", "/api/vault/agent/broker/proposals", "{}"),
    route!(Broker, "GET", "/api/vault/agent/broker/proposals/:id"),
    route!(Broker, "GET", "/api/vault/agent/cards/approvals/:id"),
    route!(Compat, "GET", "/v1/auth/token/lookup-self"),
    route!(Compat, "POST", "/v1/auth/token/lookup-self"),
    route!(Compat, "POST", "/v1/auth/token/revoke-self"),
    route!(Compat, "GET", "/v1/sys/internal/ui/mounts/secret/app/db"),
    route!(Compat, "GET", "/v1/secret/data/app/db"),
    route!(
        Compat,
        "PUT",
        "/v1/secret/data/app/db",
        r#"{"data":{"PASSWORD":"x"}}"#
    ),
    route!(
        Compat,
        "POST",
        "/v1/secret/data/app/db",
        r#"{"data":{"PASSWORD":"x"}}"#
    ),
    route!(Compat, "DELETE", "/v1/secret/data/app/db"),
    route!(Compat, "GET", "/v1/secret/metadata/app/db"),
    route!(Compat, "DELETE", "/v1/secret/metadata/app/db"),
    route!(Compat, "LIST", "/v1/secret/metadata/app"),
    route!(Compat, "GET", "/v1/secret/metadata?list=true"),
    route!(Compat, "GET", "/v1/secret/metadata/?list=true"),
    route!(Compat, "GET", "/v1/secret/metadata/app?list=true"),
    route!(Compat, "LIST", "/v1/secret/metadata"),
];

pub(super) struct Fixture {
    pub(super) store: &'static PluginSecretStore,
    pub(super) router: Router,
    pub(super) _directory: tempfile::TempDir,
    pub(super) admin: AuditActor,
    pub(super) policy: String,
    pub(super) approle: String,
    pub(super) role_id: String,
    pub(super) secret_value: String,
    pub(super) jwt_identity: String,
    pub(super) signing_key: rcgen::KeyPair,
    pub(super) other_key: rcgen::KeyPair,
}

impl Fixture {
    pub(super) async fn new() -> Self {
        crate::plugin_secrets::set_global(PluginSecretStore::in_memory().unwrap());
        let store = crate::plugin_secrets::global().expect("a published vault store");
        let tag = uuid::Uuid::new_v4().simple().to_string()[..8].to_owned();
        let admin = AuditActor::new("user", Some("pubauth-admin"));
        let policy = format!("pubauth-{tag}");
        {
            let conn = store.conn.lock().await;
            crate::vault::policy::put_policy(
                &conn,
                &Policy {
                    name: policy.clone(),
                    description: String::new(),
                    rules: vec![PolicyRule {
                        path: "**".into(),
                        capabilities: vec![
                            Capability::List,
                            Capability::Use,
                            Capability::Read,
                            Capability::Write,
                            Capability::Delete,
                            Capability::Admin,
                        ],
                        deny: false,
                        ..Default::default()
                    }],
                },
            )
            .unwrap();
        }
        // Two secrets a valid token reads and a refused request must never
        // show: one in the root folder (the agent routes), one at `app/db`
        // under the key `PASSWORD` (the `/v1/secret/data/app/db` routes).
        let secret_value = format!("pubauth-secret-value-{tag}");
        for (path, name) in [
            (crate::vault::ROOT_PATH, "PUBAUTH_SECRET"),
            ("/app/db", "PASSWORD"),
        ] {
            store
                .write_secret(WriteRequest {
                    coords: SecretCoords {
                        scope: SecretScope::Node,
                        scope_id: super::super::vault_engines_api::local_node_id(),
                        environment: crate::vault::active_environment(),
                        path: path.to_owned(),
                        binding: None,
                        name: name.to_owned(),
                    },
                    value: Some(&secret_value),
                    patch: Default::default(),
                    actor: &admin,
                    source: VersionSource::Write,
                    expected_version: None,
                })
                .await
                .unwrap();
        }
        let approle = format!("pubauth-ar-{tag}");
        let identity = store
            .machine_create(
                &approle,
                AuthMethod::AppRole {
                    role_id: String::new(),
                },
                vec![policy.clone()],
                Some(600),
                &admin,
            )
            .await
            .unwrap();
        let AuthMethod::AppRole { role_id } = identity.auth else {
            panic!("an AppRole identity");
        };
        let signing_key = rcgen::KeyPair::generate().unwrap();
        let other_key = rcgen::KeyPair::generate().unwrap();
        let jwt_identity = format!("pubauth-jwt-{tag}");
        store
            .machine_create(
                &jwt_identity,
                AuthMethod::Jwt(JwtConfig {
                    issuer: ISSUER.into(),
                    jwks_url: None,
                    public_key_pem: Some(signing_key.public_key_pem()),
                    audiences: vec![AUDIENCE.into()],
                    bound_claims: BTreeMap::new(),
                }),
                vec![policy.clone()],
                Some(600),
                &admin,
            )
            .await
            .unwrap();
        let directory = tempfile::tempdir().unwrap();
        let router =
            vault_public_routes().with_state(isolated_plugin_hook_test_state(directory.path()));
        Self {
            store,
            router,
            _directory: directory,
            admin,
            policy,
            approle,
            role_id,
            secret_value,
            jwt_identity,
            signing_key,
            other_key,
        }
    }

    pub(super) async fn new_secret_id(&self) -> String {
        self.store
            .machine_issue_secret_id(&self.approle, None, None, &self.admin)
            .await
            .unwrap()
            .0
    }

    pub(super) async fn fresh_token(&self) -> IssuedToken {
        let secret_id = self.new_secret_id().await;
        self.store
            .approle_login(&self.role_id, &secret_id)
            .await
            .unwrap()
    }

    /// A token that was valid and has since been revoked.
    pub(super) async fn revoked_token(&self) -> String {
        let token = self.fresh_token().await;
        self.store
            .token_revoke(&token.accessor, &self.admin)
            .await
            .unwrap();
        token.token
    }

    /// A token whose machine identity has since been disabled.
    pub(super) async fn disabled_identity_token(&self) -> String {
        let name = format!("{}-off", self.approle);
        let identity = self
            .store
            .machine_create(
                &name,
                AuthMethod::AppRole {
                    role_id: String::new(),
                },
                vec![self.policy.clone()],
                Some(600),
                &self.admin,
            )
            .await
            .unwrap();
        let AuthMethod::AppRole { role_id } = identity.auth else {
            panic!("an AppRole identity");
        };
        let (secret_id, _) = self
            .store
            .machine_issue_secret_id(&name, None, None, &self.admin)
            .await
            .unwrap();
        let token = self
            .store
            .approle_login(&role_id, &secret_id)
            .await
            .unwrap();
        self.store
            .machine_update(&name, None, None, Some(true), &self.admin)
            .await
            .unwrap();
        token.token
    }

    pub(super) fn jwt(&self, key: &rcgen::KeyPair) -> String {
        let encoding =
            jsonwebtoken::EncodingKey::from_ec_pem(key.serialize_pem().as_bytes()).unwrap();
        jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256),
            &json!({
                "iss": ISSUER,
                "aud": AUDIENCE,
                "exp": chrono::Utc::now().timestamp() + 300,
            }),
            &encoding,
        )
        .unwrap()
    }

    pub(super) async fn call(
        &self,
        method: &str,
        uri: &str,
        headers: &[(&str, &str)],
        body: Option<&str>,
    ) -> Reply {
        let mut request = Request::builder().method(method).uri(uri);
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        let request = match body {
            Some(body) => request
                .header("content-type", "application/json")
                .body(Body::from(body.to_owned())),
            None => request.body(Body::empty()),
        }
        .unwrap();
        let response = tokio::time::timeout(
            Duration::from_secs(20),
            self.router.clone().oneshot(request),
        )
        .await
        .unwrap_or_else(|_| panic!("{method} {uri} did not answer"))
        .unwrap();
        let status = response.status();
        let streaming = response
            .headers()
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.starts_with("text/event-stream"));
        // An event stream never ends; its status is the whole answer.
        let text = if streaming {
            String::new()
        } else {
            let bytes = axum::body::to_bytes(response.into_body(), 1 << 20)
                .await
                .unwrap();
            String::from_utf8_lossy(&bytes).into_owned()
        };
        Reply { status, text }
    }

    /// Send a request that must be refused and prove it changed no state.
    /// `expected` pins the refusal status when the route has one; `None`
    /// accepts any 4xx.
    pub(super) async fn assert_refused(
        &self,
        label: &str,
        request: (&str, &str, &[(&str, &str)], Option<&str>),
        expected: Option<StatusCode>,
        forbidden_in_body: &[&str],
    ) -> Reply {
        let (method, uri, headers, body) = request;
        let before = fingerprint(self.store).await;
        let reply = self.call(method, uri, headers, body).await;
        match expected {
            Some(status) => assert_eq!(
                reply.status, status,
                "{label}: {method} {uri} -> {} {}",
                reply.status, reply.text
            ),
            None => assert!(
                reply.status.is_client_error(),
                "{label}: {method} {uri} was not refused: {} {}",
                reply.status,
                reply.text
            ),
        }
        for needle in forbidden_in_body {
            assert!(
                !reply.text.contains(needle),
                "{label}: {method} {uri} leaked `{needle}`: {}",
                reply.text
            );
        }
        let after = fingerprint(self.store).await;
        assert_eq!(
            changed_tables(&before, &after),
            Vec::<String>::new(),
            "{label}: {method} {uri} changed vault state while refusing"
        );
        reply
    }
}

/// The credentials a token-guarded route must refuse, as `(label, headers)`.
pub(super) fn refused_credentials(
    guard: Guard,
    valid: &str,
    revoked: &str,
    disabled: &str,
) -> Vec<(&'static str, Vec<(&'static str, String)>)> {
    match guard {
        Guard::Agent | Guard::Broker => {
            let mut cases = vec![
                ("no credential", vec![]),
                ("empty token", vec![("x-ryu-vault-token", String::new())]),
                (
                    "unknown token",
                    vec![("x-ryu-vault-token", UNKNOWN_VAULT_TOKEN.to_owned())],
                ),
                (
                    "not a vault token",
                    vec![("x-ryu-vault-token", "garbage".to_owned())],
                ),
                (
                    "revoked token",
                    vec![("x-ryu-vault-token", revoked.to_owned())],
                ),
                (
                    "token of a disabled identity",
                    vec![("x-ryu-vault-token", disabled.to_owned())],
                ),
                (
                    "a valid token in the Authorization header",
                    vec![("authorization", format!("Bearer {valid}"))],
                ),
                (
                    "a valid token in the Vault-compatible header",
                    vec![("x-vault-token", valid.to_owned())],
                ),
            ];
            if guard == Guard::Broker {
                cases.push((
                    "unknown broker session",
                    vec![("authorization", format!("Bearer {UNKNOWN_SESSION}"))],
                ));
                cases.push((
                    "unknown broker session as proxy credentials",
                    vec![("proxy-authorization", format!("Bearer {UNKNOWN_SESSION}"))],
                ));
            }
            cases
        }
        Guard::Compat => vec![
            ("no credential", vec![]),
            ("empty token", vec![("x-vault-token", String::new())]),
            (
                "unknown token",
                vec![("x-vault-token", UNKNOWN_VAULT_TOKEN.to_owned())],
            ),
            (
                "unknown bearer token",
                vec![("authorization", format!("Bearer {UNKNOWN_VAULT_TOKEN}"))],
            ),
            ("revoked token", vec![("x-vault-token", revoked.to_owned())]),
            (
                "token of a disabled identity",
                vec![("x-vault-token", disabled.to_owned())],
            ),
            (
                "a valid token in the Ryu agent header",
                vec![("x-ryu-vault-token", valid.to_owned())],
            ),
        ],
    }
}
