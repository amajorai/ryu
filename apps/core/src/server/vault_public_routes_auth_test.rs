//! Public vault routes authenticate inside their handlers, not at the node
//! bearer gate, so each one must refuse a caller that presents no credential
//! or a wrong one, and a refusal must leave the vault exactly as it was.
//!
//! The router under test is `vault_public_routes()` itself (the merge that
//! `create_router` mounts on the public side), so every handler, extractor and
//! the vault `request_layer` are the shipping ones. The store is the process
//! vault store (the handlers resolve it globally), filled with a real policy,
//! an AppRole identity, a JWT identity and two secrets. A refusal is judged by
//! its status and body (which must not carry a token or a secret value) and by
//! a before/after dump of every vault table except the audit log, which
//! records denials by design. Each refusal family is paired with a positive
//! control: the same route with the right credential is admitted, and the
//! secret routes then return the value, so a refusal cannot be an unrelated
//! 4xx. The store is process-global, so each case runs alone in a child
//! process (the pattern the Agent Comms and Shadow runtime tests use), which
//! also keeps the table dump free of writes from other tests.
use std::collections::BTreeMap;
use std::time::Duration;

use axum::body::Body;
use axum::http::{Request, StatusCode};
use axum::Router;
use serde_json::{json, Value};
use tower::ServiceExt;

use super::{isolated_plugin_hook_test_state, vault_public_routes};
use crate::plugin_secrets::{
    PluginSecretStore, SecretCoords, SecretScope, VersionSource, WriteRequest,
};
use crate::vault::audit::{AuditActor, AuditFilter, AuditRow};
use crate::vault::auth_methods::{AwsIamAuthConfig, CertAuthConfig, KubernetesAuthConfig};
use crate::vault::machine::{AuthMethod, IssuedToken, JwtConfig, MachineIdentity};
use crate::vault::policy::{Capability, Policy, PolicyRule};

const ISSUER: &str = "https://issuer.pubauth.test";
const AUDIENCE: &str = "ryu";
const CA_PATH: &str = "/api/vault/broker/ca.pem";
const UNKNOWN_VAULT_TOKEN: &str =
    "rvt_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UNKNOWN_SESSION: &str = "rvb_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const UNKNOWN_WRAP_TOKEN: &str =
    "rvw_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const ISOLATED_CHILD_ENV: &str = "RYU_CORE_VAULT_PUBLIC_AUTH_CHILD";

/// Whether this process is the isolated child that runs `test`. In any other
/// process it starts the child, waits for it and asserts that it passed, and
/// returns `false` so the caller has nothing left to do.
///
/// `test` is spelled out at each call site, and a name that matches no test
/// makes libtest run nothing and exit 0. The child's own report must therefore
/// say that exactly one test ran and passed, or a renamed function, a moved
/// module or a typo would leave its isolated case asserting nothing.
fn in_isolated_process(test: &str) -> bool {
    if std::env::var_os(ISOLATED_CHILD_ENV).is_some() {
        return true;
    }
    let data_dir = tempfile::tempdir().expect("a data directory for the child");
    let output = std::process::Command::new(std::env::current_exe().expect("the test binary"))
        .args([
            "--exact",
            &format!("server::vault_public_routes_auth_test::{test}"),
            "--nocapture",
        ])
        .env(ISOLATED_CHILD_ENV, "1")
        .env("RYU_PROFILE", "dev")
        .env("RYU_KEYCHAIN", "off")
        .env("RYU_DIR", data_dir.path())
        .output()
        .expect("start the isolated vault test process");
    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(
        output.status.success(),
        "isolated `{test}` failed: {}\n--- stdout ---\n{stdout}\n--- stderr ---\n{stderr}",
        output.status
    );
    assert!(
        stdout.contains("1 passed; 0 failed"),
        "isolated `{test}` ran no test: the child must report `1 passed; 0 failed`, got:\n{stdout}"
    );
    false
}

/// A child whose name matches no test exits 0 having run nothing, so the
/// parent must not read that as a pass: a renamed function or a typo in a
/// call site would otherwise leave its isolated case asserting nothing.
#[test]
#[should_panic(expected = "ran no test")]
fn an_isolated_child_that_matches_no_test_is_a_failure() {
    in_isolated_process("no_such_vault_public_routes_test");
}

/// How a route reads the credential it refuses on.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Guard {
    /// `x-ryu-vault-token` only; refusal is `401 vault_token_invalid`.
    Agent,
    /// `x-ryu-vault-token` or an `rvb_` broker session; refusal is `401`.
    Broker,
    /// HashiCorp-compatible `X-Vault-Token` or `Authorization: Bearer`;
    /// refusal is `403 permission denied`.
    Compat,
}

struct Route {
    guard: Guard,
    method: &'static str,
    pattern: &'static str,
    body: Option<&'static str>,
}

impl Route {
    /// The pattern with every `:param` segment replaced by a sample value.
    fn uri(&self) -> String {
        self.pattern
            .split('/')
            .map(|segment| {
                if segment.starts_with(':') {
                    "sample"
                } else {
                    segment
                }
            })
            .collect::<Vec<_>>()
            .join("/")
    }
}

macro_rules! route {
    ($guard:ident, $method:literal, $pattern:literal) => {
        Route {
            guard: Guard::$guard,
            method: $method,
            pattern: $pattern,
            body: None,
        }
    };
    ($guard:ident, $method:literal, $pattern:literal, $body:literal) => {
        Route {
            guard: Guard::$guard,
            method: $method,
            pattern: $pattern,
            body: Some($body),
        }
    };
}

/// Every public route that authenticates with a presented token. Logins, the
/// wrapping routes and the routes public by design are listed separately.
const ROUTES: &[Route] = &[
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

const LOGIN_PATHS: [&str; 5] = [
    "/api/vault/auth/approle/login",
    "/api/vault/auth/jwt/login",
    "/api/vault/auth/cert/login",
    "/api/vault/auth/aws/login",
    "/api/vault/auth/kubernetes/login",
];
const COMPAT_LOGIN_PATHS: [&str; 2] = ["/v1/auth/approle/login", "/v1/auth/jwt/login"];
const WRAP_PATHS: [&str; 3] = [
    "/api/vault/sys/wrapping/unwrap",
    "/api/vault/sys/wrapping/lookup",
    "/api/vault/sys/wrapping/rewrap",
];
const PUBLIC_BY_DESIGN: [&str; 3] = [
    CA_PATH,
    "/api/vault/identity/.well-known/openid-configuration",
    "/api/vault/identity/.well-known/keys",
];

struct Reply {
    status: StatusCode,
    text: String,
}

struct Fixture {
    store: &'static PluginSecretStore,
    router: Router,
    _directory: tempfile::TempDir,
    admin: AuditActor,
    policy: String,
    approle: String,
    role_id: String,
    secret_value: String,
    jwt_identity: String,
    signing_key: rcgen::KeyPair,
    other_key: rcgen::KeyPair,
}

impl Fixture {
    async fn new() -> Self {
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
                        scope_id: super::vault_engines_api::local_node_id(),
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

    async fn new_secret_id(&self) -> String {
        self.store
            .machine_issue_secret_id(&self.approle, None, None, &self.admin)
            .await
            .unwrap()
            .0
    }

    async fn fresh_token(&self) -> IssuedToken {
        let secret_id = self.new_secret_id().await;
        self.store
            .approle_login(&self.role_id, &secret_id)
            .await
            .unwrap()
    }

    /// A token that was valid and has since been revoked.
    async fn revoked_token(&self) -> String {
        let token = self.fresh_token().await;
        self.store
            .token_revoke(&token.accessor, &self.admin)
            .await
            .unwrap();
        token.token
    }

    /// A token whose machine identity has since been disabled.
    async fn disabled_identity_token(&self) -> String {
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

    fn jwt(&self, key: &rcgen::KeyPair) -> String {
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

    async fn call(
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
    async fn assert_refused(
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

/// Every vault table's rows, except the audit log and its chain head,
/// rendered to strings.
async fn fingerprint(store: &PluginSecretStore) -> BTreeMap<String, Vec<String>> {
    let conn = store.conn.lock().await;
    let tables: Vec<String> = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .unwrap()
        .query_map([], |row| row.get(0))
        .unwrap()
        .collect::<Result<_, _>>()
        .unwrap();
    let mut dump = BTreeMap::new();
    for table in tables {
        if table == "vault_audit" {
            continue;
        }
        // The chain head of the audit log lives in `vault_meta`; it moves with
        // every audit row, which is excluded for the same reason.
        let query = if table == "vault_meta" {
            "SELECT * FROM vault_meta WHERE key NOT IN ('audit_head', 'audit_anchor')".to_owned()
        } else {
            format!("SELECT * FROM \"{table}\"")
        };
        let mut statement = conn.prepare(&query).unwrap();
        let columns = statement.column_count();
        let mut rows: Vec<String> = statement
            .query_map([], |row| {
                Ok((0..columns)
                    .map(|index| format!("{:?}", row.get_ref(index).unwrap()))
                    .collect::<Vec<_>>()
                    .join("|"))
            })
            .unwrap()
            .collect::<Result<_, _>>()
            .unwrap();
        rows.sort();
        dump.insert(table, rows);
    }
    dump
}

fn changed_tables(
    before: &BTreeMap<String, Vec<String>>,
    after: &BTreeMap<String, Vec<String>>,
) -> Vec<String> {
    before
        .keys()
        .chain(after.keys())
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .filter(|table| before.get(*table) != after.get(*table))
        .cloned()
        .collect()
}

/// The credentials a token-guarded route must refuse, as `(label, headers)`.
fn refused_credentials(
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

#[tokio::test]
async fn token_guarded_routes_refuse_a_missing_or_wrong_token_and_change_nothing() {
    if !in_isolated_process(
        "token_guarded_routes_refuse_a_missing_or_wrong_token_and_change_nothing",
    ) {
        return;
    }
    let fixture = Fixture::new().await;
    let valid = fixture.fresh_token().await.token;
    let revoked = fixture.revoked_token().await;
    let disabled = fixture.disabled_identity_token().await;
    let mut attempts = 0;
    for route in ROUTES {
        let uri = route.uri();
        let (status, needle) = match route.guard {
            Guard::Agent | Guard::Broker => (StatusCode::UNAUTHORIZED, "vault_token_invalid"),
            Guard::Compat => (StatusCode::FORBIDDEN, "permission denied"),
        };
        for (label, headers) in refused_credentials(route.guard, &valid, &revoked, &disabled) {
            let headers: Vec<(&str, &str)> = headers
                .iter()
                .map(|(name, value)| (*name, value.as_str()))
                .collect();
            let reply = fixture
                .assert_refused(
                    label,
                    (route.method, &uri, &headers, route.body),
                    Some(status),
                    &[
                        valid.as_str(),
                        revoked.as_str(),
                        disabled.as_str(),
                        fixture.secret_value.as_str(),
                    ],
                )
                .await;
            assert!(
                reply.text.contains(needle),
                "{label}: {} {uri} refused without `{needle}`: {}",
                route.method,
                reply.text
            );
            attempts += 1;
        }
    }
    // 22 agent routes x 8 credentials, 5 broker routes x 10, 15 compat routes
    // x 7: a route or a credential that silently stops being tried shows up
    // as a different count.
    assert_eq!(attempts, 22 * 8 + 5 * 10 + 15 * 7);
}

#[tokio::test]
async fn token_guarded_routes_admit_a_valid_token_so_the_refusals_are_credential_driven() {
    if !in_isolated_process(
        "token_guarded_routes_admit_a_valid_token_so_the_refusals_are_credential_driven",
    ) {
        return;
    }
    let fixture = Fixture::new().await;

    // The routes that return a secret return it to a valid token: the value a
    // refusal must never show is really there to be shown.
    let token = fixture.fresh_token().await.token;
    let reads = [
        (
            "x-ryu-vault-token",
            "GET",
            "/api/vault/agent/secrets/PUBAUTH_SECRET",
            None,
        ),
        (
            "x-ryu-vault-token",
            "POST",
            "/api/vault/agent/export",
            Some("{}"),
        ),
        ("x-vault-token", "GET", "/v1/secret/data/app/db", None),
    ];
    for (header, method, uri, body) in reads {
        let reply = fixture
            .call(method, uri, &[(header, token.as_str())], body)
            .await;
        assert_eq!(
            reply.status,
            StatusCode::OK,
            "{method} {uri}: {}",
            reply.text
        );
        assert!(
            reply.text.contains(&fixture.secret_value),
            "{method} {uri} did not return the secret: {}",
            reply.text
        );
    }

    for route in ROUTES {
        // A fresh token per route: some routes revoke the token they get.
        let token = fixture.fresh_token().await.token;
        let uri = route.uri();
        let header = match route.guard {
            Guard::Agent | Guard::Broker => "x-ryu-vault-token",
            Guard::Compat => "x-vault-token",
        };
        let reply = fixture
            .call(route.method, &uri, &[(header, token.as_str())], route.body)
            .await;
        assert_ne!(
            reply.status,
            StatusCode::UNAUTHORIZED,
            "{} {uri}: a valid token was refused as a credential: {}",
            route.method,
            reply.text
        );
        assert!(
            !reply.text.contains("vault_token_invalid"),
            "{} {uri}: a valid token was refused as a credential: {} {}",
            route.method,
            reply.status,
            reply.text
        );
        if route.guard == Guard::Compat {
            // The compat surface refuses with 403; a token holding every
            // capability is not refused.
            assert_ne!(
                reply.status,
                StatusCode::FORBIDDEN,
                "{} {uri}: a valid token with every capability was denied: {}",
                route.method,
                reply.text
            );
        }
    }
}

#[tokio::test]
async fn broker_routes_also_refuse_a_machine_token_in_the_session_slot() {
    if !in_isolated_process("broker_routes_also_refuse_a_machine_token_in_the_session_slot") {
        return;
    }
    let fixture = Fixture::new().await;
    let valid = fixture.fresh_token().await.token;
    let bearer = format!("Bearer {valid}");
    // `rvb_` sessions are the second credential on the broker routes; a
    // machine token presented as a session credential is not one.
    for uri in [
        "/api/vault/agent/broker/discover",
        "/api/vault/agent/broker/proposals/sample",
        "/api/vault/agent/cards/approvals/sample",
    ] {
        for header in ["authorization", "proxy-authorization"] {
            fixture
                .assert_refused(
                    "machine token as session",
                    ("GET", uri, &[(header, bearer.as_str())], None),
                    Some(StatusCode::UNAUTHORIZED),
                    &[valid.as_str(), fixture.secret_value.as_str()],
                )
                .await;
        }
    }
}

#[tokio::test]
async fn machine_logins_refuse_wrong_credentials_mint_nothing_and_burn_no_secret_id() {
    if !in_isolated_process(
        "machine_logins_refuse_wrong_credentials_mint_nothing_and_burn_no_secret_id",
    ) {
        return;
    }
    let fixture = Fixture::new().await;
    let secret_id = fixture.new_secret_id().await;
    let right_jwt = fixture.jwt(&fixture.signing_key);
    let wrong_jwt = fixture.jwt(&fixture.other_key);
    let role_id = fixture.role_id.clone();
    let jwt_identity = fixture.jwt_identity.clone();
    let approle = fixture.approle.clone();

    // `(label, path, body, exact refusal status)`; `None` accepts any 4xx.
    //
    // Every identity login refuses with 403 whatever went wrong: an unknown
    // identity name, an identity that logs in another way and a wrong
    // credential all look the same, so a caller cannot learn which machine
    // identity names exist or how they log in. The bodies are compared in
    // `native_identity_logins_refuse_every_failure_with_one_body`.
    let denied = Some(StatusCode::FORBIDDEN);
    let attempts: Vec<(&str, &str, Value, Option<StatusCode>)> = vec![
        (
            "approle with a wrong secret id",
            LOGIN_PATHS[0],
            json!({ "roleId": role_id, "secretId": "sid_wrong" }),
            denied,
        ),
        (
            "approle with a wrong role id and a real secret id",
            LOGIN_PATHS[0],
            json!({ "roleId": "rid_wrong", "secretId": secret_id }),
            denied,
        ),
        (
            "approle with empty credentials",
            LOGIN_PATHS[0],
            json!({ "roleId": "", "secretId": "" }),
            denied,
        ),
        (
            "approle with no credentials at all",
            LOGIN_PATHS[0],
            json!({}),
            None,
        ),
        (
            "jwt signed by another key",
            LOGIN_PATHS[1],
            json!({ "identity": jwt_identity, "jwt": wrong_jwt }),
            denied,
        ),
        (
            "jwt that is not a jwt",
            LOGIN_PATHS[1],
            json!({ "identity": jwt_identity, "jwt": "not.a.jwt" }),
            denied,
        ),
        (
            "jwt that is empty",
            LOGIN_PATHS[1],
            json!({ "identity": jwt_identity, "jwt": "" }),
            denied,
        ),
        (
            "jwt for an unknown identity",
            LOGIN_PATHS[1],
            json!({ "identity": "nobody-pubauth", "jwt": right_jwt }),
            denied,
        ),
        (
            "jwt for an identity that logs in with an approle",
            LOGIN_PATHS[1],
            json!({ "identity": approle, "jwt": right_jwt }),
            denied,
        ),
        (
            "certificate login for an unknown identity",
            LOGIN_PATHS[2],
            json!({ "identity": "nobody-pubauth", "certificatePem": "x", "proof": "x" }),
            denied,
        ),
        (
            "certificate login for an approle identity",
            LOGIN_PATHS[2],
            json!({ "identity": approle, "certificatePem": "x", "proof": "x" }),
            denied,
        ),
        (
            "aws login for an unknown identity",
            LOGIN_PATHS[3],
            json!({
                "identity": "nobody-pubauth",
                "iamHttpRequestMethod": "POST",
                "iamRequestUrl": "aHR0cHM6Ly9zdHMuYW1hem9uYXdzLmNvbS8=",
                "iamRequestBody": "QWN0aW9uPUdldENhbGxlcklkZW50aXR5",
                "iamRequestHeaders": "e30=",
            }),
            denied,
        ),
        (
            "aws login for an approle identity",
            LOGIN_PATHS[3],
            json!({
                "identity": approle,
                "iamHttpRequestMethod": "POST",
                "iamRequestUrl": "aHR0cHM6Ly9zdHMuYW1hem9uYXdzLmNvbS8=",
                "iamRequestBody": "QWN0aW9uPUdldENhbGxlcklkZW50aXR5",
                "iamRequestHeaders": "e30=",
            }),
            denied,
        ),
        (
            "kubernetes login for an unknown identity",
            LOGIN_PATHS[4],
            json!({ "identity": "nobody-pubauth", "jwt": "x" }),
            denied,
        ),
        (
            "kubernetes login for an approle identity",
            LOGIN_PATHS[4],
            json!({ "identity": approle, "jwt": "x" }),
            denied,
        ),
        (
            "compat approle with a wrong secret id",
            COMPAT_LOGIN_PATHS[0],
            json!({ "role_id": role_id, "secret_id": "sid_wrong" }),
            denied,
        ),
        (
            "compat approle with a wrong role id and a real secret id",
            COMPAT_LOGIN_PATHS[0],
            json!({ "role_id": "rid_wrong", "secret_id": secret_id }),
            denied,
        ),
        (
            "compat approle with no credentials",
            COMPAT_LOGIN_PATHS[0],
            json!({}),
            None,
        ),
        (
            "compat jwt signed by another key",
            COMPAT_LOGIN_PATHS[1],
            json!({ "role": jwt_identity, "jwt": wrong_jwt }),
            denied,
        ),
        (
            "compat jwt for an unknown identity",
            COMPAT_LOGIN_PATHS[1],
            json!({ "role": "nobody-pubauth", "jwt": right_jwt }),
            denied,
        ),
        (
            "compat jwt with no credentials",
            COMPAT_LOGIN_PATHS[1],
            json!({}),
            None,
        ),
    ];
    for (label, path, body, expected) in &attempts {
        let reply = fixture
            .assert_refused(
                label,
                ("POST", path, &[], Some(&body.to_string())),
                *expected,
                &["rvt_", "client_token", fixture.secret_value.as_str()],
            )
            .await;
        assert!(
            !reply.status.is_success(),
            "{label}: {path} answered {}",
            reply.status
        );
    }

    // The same credentials, corrected, are accepted: the refusals above were
    // about the credential, and they did not consume the real secret id.
    let accepted = [
        (
            "approle",
            LOGIN_PATHS[0],
            json!({ "roleId": role_id, "secretId": secret_id }),
        ),
        (
            "jwt",
            LOGIN_PATHS[1],
            json!({ "identity": jwt_identity, "jwt": right_jwt }),
        ),
        (
            "compat approle",
            COMPAT_LOGIN_PATHS[0],
            json!({ "role_id": role_id, "secret_id": fixture.new_secret_id().await }),
        ),
        (
            "compat jwt",
            COMPAT_LOGIN_PATHS[1],
            json!({ "role": jwt_identity, "jwt": right_jwt }),
        ),
    ];
    for (label, path, body) in accepted {
        let reply = fixture
            .call("POST", path, &[], Some(&body.to_string()))
            .await;
        assert_eq!(reply.status, StatusCode::OK, "{label}: {}", reply.text);
        assert!(reply.text.contains("rvt_"), "{label}: {}", reply.text);
    }
}

const UNKNOWN_IDENTITY: &str = "nobody-pubauth";

/// A CA certificate, so a `cert` identity can be created.
fn test_ca_pem() -> String {
    let key = rcgen::KeyPair::generate().unwrap();
    let mut params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "pubauth CA");
    params.self_signed(&key).unwrap().pem()
}

/// An enabled identity and a disabled one that log in the same way.
async fn identity_pair(
    fixture: &Fixture,
    kind: &str,
    method: AuthMethod,
) -> (MachineIdentity, MachineIdentity) {
    let tag = uuid::Uuid::new_v4().simple().to_string()[..8].to_owned();
    let name = format!("pubauth-{kind}-{tag}");
    let enabled = fixture
        .store
        .machine_create(
            &name,
            method.clone(),
            vec![fixture.policy.clone()],
            Some(600),
            &fixture.admin,
        )
        .await
        .unwrap();
    let off = fixture
        .store
        .machine_create(
            &format!("{name}-off"),
            method,
            vec![fixture.policy.clone()],
            Some(600),
            &fixture.admin,
        )
        .await
        .unwrap();
    let disabled = fixture
        .store
        .machine_update(&off.name, None, None, Some(true), &fixture.admin)
        .await
        .unwrap();
    (enabled, disabled)
}

/// The `denied` audit rows of one login action, newest first.
async fn denied_login_rows(store: &PluginSecretStore, action: &str) -> Vec<AuditRow> {
    let conn = store.conn.lock().await;
    crate::vault::audit::list(
        &conn,
        &AuditFilter {
            limit: 500,
            action: Some(action.to_owned()),
            ..AuditFilter::default()
        },
    )
    .unwrap()
    .into_iter()
    .filter(|row| row.outcome == "denied")
    .collect()
}

/// A native login route, the audit action it records, and an enabled and a
/// disabled identity that log in with it.
struct NativeLogin {
    path: &'static str,
    action: &'static str,
    enabled: MachineIdentity,
    disabled: MachineIdentity,
    /// The request body for an identity name, carrying a credential that is
    /// refused (and refused before anything leaves the machine).
    body: Box<dyn Fn(&str) -> Value>,
}

/// A caller who is not authenticated must not learn from a refused login which
/// machine identity names exist, which of them log in another way, which are
/// disabled, or why a credential failed: an unknown identity, an identity of
/// another auth method, a disabled identity and a wrong credential get one
/// status and byte-identical body. The operator still gets the real reason,
/// from the audit log.
#[tokio::test]
async fn native_identity_logins_refuse_every_failure_with_one_body() {
    if !in_isolated_process("native_identity_logins_refuse_every_failure_with_one_body") {
        return;
    }
    let fixture = Fixture::new().await;
    // The Kubernetes identity pins its API server through the environment, and
    // its reviewer token variable is left unset: a login is then refused
    // before it makes any network call.
    std::env::set_var(
        "RYU_VAULT_K8S_HOST_PUBAUTH",
        "https://k8s.pubauth.test:6443",
    );
    let wrong_jwt = fixture.jwt(&fixture.other_key);
    let approle = fixture.store.machine_get(&fixture.approle).await.unwrap();

    let (jwt, jwt_off) = identity_pair(
        &fixture,
        "jwt",
        AuthMethod::Jwt(JwtConfig {
            issuer: ISSUER.into(),
            jwks_url: None,
            public_key_pem: Some(fixture.signing_key.public_key_pem()),
            audiences: vec![AUDIENCE.into()],
            bound_claims: BTreeMap::new(),
        }),
    )
    .await;
    let (cert, cert_off) = identity_pair(
        &fixture,
        "cert",
        AuthMethod::Cert(CertAuthConfig {
            ca_pem: test_ca_pem(),
            allowed_common_names: vec!["pubauth-node".into()],
            allowed_dns_sans: Vec::new(),
            allowed_uri_sans: Vec::new(),
        }),
    )
    .await;
    let (aws, aws_off) = identity_pair(
        &fixture,
        "aws",
        AuthMethod::AwsIam(AwsIamAuthConfig {
            bound_iam_principal_arns: vec!["arn:aws:iam::123456789012:role/pubauth".into()],
            server_id_header_value: Some("pubauth.test".into()),
            sts_endpoint: None,
        }),
    )
    .await;
    let (kubernetes, kubernetes_off) = identity_pair(
        &fixture,
        "k8s",
        AuthMethod::Kubernetes(KubernetesAuthConfig {
            host: "https://k8s.pubauth.test:6443".into(),
            ca_pem: None,
            reviewer_jwt_env: Some("RYU_VAULT_K8S_REVIEWER_PUBAUTH".into()),
            bound_service_account_names: vec!["pubauth".into()],
            bound_service_account_namespaces: vec!["pubauth".into()],
            audiences: Vec::new(),
        }),
    )
    .await;

    let (approle_on, approle_off) = identity_pair(
        &fixture,
        "approle",
        AuthMethod::AppRole {
            role_id: String::new(),
        },
    )
    .await;
    let logins = vec![
        NativeLogin {
            path: LOGIN_PATHS[1],
            action: "auth.jwt.login",
            enabled: jwt,
            disabled: jwt_off,
            body: Box::new(move |identity| json!({ "identity": identity, "jwt": wrong_jwt })),
        },
        NativeLogin {
            path: LOGIN_PATHS[2],
            action: "auth.cert.login",
            enabled: cert,
            disabled: cert_off,
            body: Box::new(
                |identity| json!({ "identity": identity, "certificatePem": "x", "proof": "x" }),
            ),
        },
        NativeLogin {
            path: LOGIN_PATHS[3],
            action: "auth.aws_iam.login",
            enabled: aws,
            disabled: aws_off,
            // A GET is not a signed `GetCallerIdentity`: refused before STS.
            body: Box::new(|identity| {
                json!({
                    "identity": identity,
                    "iamHttpRequestMethod": "GET",
                    "iamRequestUrl": "aHR0cHM6Ly9zdHMuYW1hem9uYXdzLmNvbS8=",
                    "iamRequestBody": "QWN0aW9uPUdldENhbGxlcklkZW50aXR5",
                    "iamRequestHeaders": "e30=",
                })
            }),
        },
        NativeLogin {
            path: LOGIN_PATHS[4],
            action: "auth.kubernetes.login",
            enabled: kubernetes,
            disabled: kubernetes_off,
            body: Box::new(|identity| json!({ "identity": identity, "jwt": "x" })),
        },
    ];

    let before = fingerprint(fixture.store).await;
    // Collected rather than asserted one by one, so a failing run lists every
    // route and case it got wrong.
    let mut problems: Vec<String> = Vec::new();
    for login in &logins {
        let cases = [
            ("an unknown identity", UNKNOWN_IDENTITY.to_owned()),
            ("an identity of another auth method", approle.name.clone()),
            ("a disabled identity", login.disabled.name.clone()),
            ("a wrong credential", login.enabled.name.clone()),
        ];
        let mut replies = Vec::new();
        for (label, name) in &cases {
            let body = (login.body)(name).to_string();
            let reply = fixture.call("POST", login.path, &[], Some(&body)).await;
            if reply.status != StatusCode::FORBIDDEN {
                problems.push(format!(
                    "{} {label}: answered {} {}",
                    login.path, reply.status, reply.text
                ));
            }
            for secret in [
                UNKNOWN_IDENTITY,
                approle.name.as_str(),
                login.enabled.name.as_str(),
                login.disabled.name.as_str(),
                "rvt_",
            ] {
                if reply.text.contains(secret) {
                    problems.push(format!(
                        "{} {label}: the body carries `{secret}`: {}",
                        login.path, reply.text
                    ));
                }
            }
            replies.push((*label, reply));
        }
        let (first_label, first) = &replies[0];
        for (label, reply) in &replies[1..] {
            if reply.text != first.text {
                problems.push(format!(
                    "{}: {label} answered `{}` but {first_label} answered `{}`",
                    login.path, reply.text, first.text
                ));
            }
        }
    }

    // AppRole already answers every failure alike; it stays that way.
    let role_id_of = |identity: &MachineIdentity| match &identity.auth {
        AuthMethod::AppRole { role_id } => role_id.clone(),
        other => panic!("an AppRole identity, got {other:?}"),
    };
    let approle_cases = [
        ("an unknown role id", "rid_unknown".to_owned()),
        ("a disabled identity", role_id_of(&approle_off)),
        ("a wrong secret id", role_id_of(&approle_on)),
    ];
    let mut approle_replies = Vec::new();
    for (label, role_id) in &approle_cases {
        let body = json!({ "roleId": role_id, "secretId": "sid_wrong" }).to_string();
        let reply = fixture.call("POST", LOGIN_PATHS[0], &[], Some(&body)).await;
        if reply.status != StatusCode::FORBIDDEN {
            problems.push(format!(
                "{} {label}: answered {} {}",
                LOGIN_PATHS[0], reply.status, reply.text
            ));
        }
        approle_replies.push((*label, reply));
    }
    for (label, reply) in &approle_replies[1..] {
        if reply.text != approle_replies[0].1.text {
            problems.push(format!(
                "{}: {label} answered `{}` but {} answered `{}`",
                LOGIN_PATHS[0], reply.text, approle_replies[0].0, approle_replies[0].1.text
            ));
        }
    }

    let after = fingerprint(fixture.store).await;
    let changed = changed_tables(&before, &after);
    if !changed.is_empty() {
        problems.push(format!("a refused login changed vault state: {changed:?}"));
    }

    // The reason a login was refused is for the operator: one denied audit
    // row per refusal, naming the attempted identity when it was unknown.
    for login in &logins {
        let rows = denied_login_rows(fixture.store, login.action).await;
        let recorded = |actor: Option<&str>, reason: &str, identity: Option<&str>| {
            rows.iter().any(|row| {
                row.actor.kind == "machine"
                    && row.actor.id.as_deref() == actor
                    && row.details["reason"]
                        .as_str()
                        .is_some_and(|text| text.contains(reason))
                    && identity.is_none_or(|name| row.details["identity"].as_str() == Some(name))
            })
        };
        if !recorded(None, "not_found", Some(UNKNOWN_IDENTITY)) {
            problems.push(format!(
                "{}: no denied `{}` row for the unknown identity: {rows:?}",
                login.path, login.action
            ));
        }
        if !recorded(
            Some(approle.id.as_str()),
            "does not use",
            Some(approle.name.as_str()),
        ) {
            problems.push(format!(
                "{}: no denied `{}` row for the identity of another auth method: {rows:?}",
                login.path, login.action
            ));
        }
        if !recorded(
            Some(login.disabled.id.as_str()),
            "disabled",
            Some(login.disabled.name.as_str()),
        ) {
            problems.push(format!(
                "{}: no denied `{}` row for the disabled identity: {rows:?}",
                login.path, login.action
            ));
        }
        if !recorded(Some(login.enabled.id.as_str()), "", None) {
            problems.push(format!(
                "{}: no denied `{}` row, with a reason, for the wrong credential: {rows:?}",
                login.path, login.action
            ));
        }
    }
    assert!(
        problems.is_empty(),
        "{} problem(s):\n{}",
        problems.len(),
        problems.join("\n")
    );
}

/// Restores the thread's fail-closed override even if an assert fails.
struct FailClosed;

impl FailClosed {
    fn on() -> Self {
        crate::vault::audit_devices::set_fail_closed_for_test(Some(true));
        Self
    }
}

impl Drop for FailClosed {
    fn drop(&mut self) {
        crate::vault::audit_devices::set_fail_closed_for_test(None);
    }
}

/// A login the audit log would not take stays a 503 the caller can retry, and
/// the audit row that records a refusal is best-effort: with fail-closed
/// auditing on, a refused login is still the same 403, never a 503 that would
/// set a refused identity apart. (A sealed vault has no route-level case: no
/// login touches the keyring. The status mapping is pinned by the unit tests
/// of `login_refusal`.)
#[tokio::test]
async fn native_jwt_login_keeps_a_fail_closed_audit_refusal_retryable() {
    if !in_isolated_process("native_jwt_login_keeps_a_fail_closed_audit_refusal_retryable") {
        return;
    }
    let fixture = Fixture::new().await;
    let right_jwt = fixture.jwt(&fixture.signing_key);
    let wrong_jwt = fixture.jwt(&fixture.other_key);
    let login = json!({ "identity": fixture.jwt_identity, "jwt": right_jwt }).to_string();
    let unknown = json!({ "identity": UNKNOWN_IDENTITY, "jwt": right_jwt }).to_string();
    let wrong = json!({ "identity": fixture.jwt_identity, "jwt": wrong_jwt }).to_string();

    let refused = fixture
        .call("POST", LOGIN_PATHS[1], &[], Some(&unknown))
        .await;
    assert_eq!(refused.status, StatusCode::FORBIDDEN, "{}", refused.text);
    {
        let _fail_closed = FailClosed::on();
        for (label, body) in [("unknown identity", &unknown), ("wrong credential", &wrong)] {
            let reply = fixture.call("POST", LOGIN_PATHS[1], &[], Some(body)).await;
            assert_eq!(
                reply.status,
                StatusCode::FORBIDDEN,
                "{label} under fail-closed auditing: {}",
                reply.text
            );
            assert_eq!(
                reply.text, refused.text,
                "{label} under fail-closed auditing"
            );
        }
        let unavailable = fixture
            .call("POST", LOGIN_PATHS[1], &[], Some(&login))
            .await;
        assert_eq!(
            unavailable.status,
            StatusCode::SERVICE_UNAVAILABLE,
            "{}",
            unavailable.text
        );
        assert!(
            unavailable.text.contains("vault_audit_unavailable"),
            "{}",
            unavailable.text
        );
        assert!(!unavailable.text.contains("rvt_"), "{}", unavailable.text);
    }
    // The refusal was about the audit log, not the credential: with the audit
    // log back, the same login is admitted.
    let admitted = fixture
        .call("POST", LOGIN_PATHS[1], &[], Some(&login))
        .await;
    assert_eq!(admitted.status, StatusCode::OK, "{}", admitted.text);
    assert!(admitted.text.contains("rvt_"), "{}", admitted.text);
}

#[tokio::test]
async fn wrapping_routes_refuse_a_missing_or_wrong_wrap_token_and_keep_the_wrapped_value() {
    if !in_isolated_process(
        "wrapping_routes_refuse_a_missing_or_wrong_wrap_token_and_keep_the_wrapped_value",
    ) {
        return;
    }
    let fixture = Fixture::new().await;
    let tag = uuid::Uuid::new_v4().simple().to_string();
    let payload = format!("wrapped-value-{tag}");
    let wrapped = fixture
        .store
        .wrap_response(
            json!({ "secret": payload }).to_string().as_bytes(),
            300,
            "pubauth/test",
            &fixture.admin,
        )
        .await
        .unwrap();
    let wrap_token = wrapped.token.clone().expect("a wrapping token");
    let machine_token = fixture.fresh_token().await.token;

    for path in WRAP_PATHS {
        let unknown_body = json!({ "token": UNKNOWN_WRAP_TOKEN }).to_string();
        let machine_body = json!({ "token": machine_token }).to_string();
        let cases: Vec<(&str, Vec<(&str, &str)>, Option<&str>, Option<StatusCode>)> = vec![
            (
                "no wrapping token",
                vec![],
                None,
                Some(StatusCode::BAD_REQUEST),
            ),
            (
                "an empty body",
                vec![],
                Some("{}"),
                Some(StatusCode::BAD_REQUEST),
            ),
            (
                "an empty wrapping token header",
                vec![("x-ryu-wrap-token", "")],
                None,
                Some(StatusCode::BAD_REQUEST),
            ),
            (
                "an unknown token in the body",
                vec![],
                Some(unknown_body.as_str()),
                None,
            ),
            (
                "an unknown token in the wrap header",
                vec![("x-ryu-wrap-token", UNKNOWN_WRAP_TOKEN)],
                None,
                None,
            ),
            (
                "a machine token as the wrapping token",
                vec![],
                Some(machine_body.as_str()),
                None,
            ),
            (
                "a machine token in the wrap header",
                vec![("x-ryu-wrap-token", machine_token.as_str())],
                None,
                None,
            ),
        ];
        for (label, headers, body, expected) in cases {
            fixture
                .assert_refused(
                    label,
                    ("POST", path, &headers, body),
                    expected,
                    &[payload.as_str(), wrap_token.as_str()],
                )
                .await;
        }
    }

    // The refusals left the real wrapped value intact: it describes itself,
    // unwraps once with the right token, and a replay is refused.
    let lookup = fixture
        .call(
            "POST",
            WRAP_PATHS[1],
            &[],
            Some(&json!({ "token": wrap_token }).to_string()),
        )
        .await;
    assert_eq!(lookup.status, StatusCode::OK, "{}", lookup.text);
    assert!(!lookup.text.contains(&payload), "{}", lookup.text);
    let unwrap_body = json!({ "token": wrap_token }).to_string();
    let unwrapped = fixture
        .call("POST", WRAP_PATHS[0], &[], Some(&unwrap_body))
        .await;
    assert_eq!(unwrapped.status, StatusCode::OK, "{}", unwrapped.text);
    assert!(unwrapped.text.contains(&payload), "{}", unwrapped.text);
    fixture
        .assert_refused(
            "a replayed wrapping token",
            ("POST", WRAP_PATHS[0], &[], Some(&unwrap_body)),
            None,
            &[payload.as_str()],
        )
        .await;
}

#[tokio::test]
async fn routes_public_by_design_need_no_credential_expose_no_key_and_create_nothing() {
    if !in_isolated_process(
        "routes_public_by_design_need_no_credential_expose_no_key_and_create_nothing",
    ) {
        return;
    }
    let fixture = Fixture::new().await;
    for path in PUBLIC_BY_DESIGN {
        let before = fingerprint(fixture.store).await;
        let reply = fixture.call("GET", path, &[], None).await;
        assert!(
            reply.status == StatusCode::OK || reply.status == StatusCode::NOT_FOUND,
            "{path}: {} {}",
            reply.status,
            reply.text
        );
        assert!(
            !reply.text.contains("PRIVATE KEY"),
            "{path}: {}",
            reply.text
        );
        assert!(!reply.text.contains("\"d\":"), "{path}: {}", reply.text);
        let after = fingerprint(fixture.store).await;
        assert_eq!(
            changed_tables(&before, &after),
            Vec::<String>::new(),
            "{path}: an anonymous read changed vault state"
        );
    }
}

/// Whether the classified `candidate` is the registered route `path`: the
/// same pattern, a concrete segment where the registration has a `:param`, or
/// a concrete path under a `*wildcard` registration.
fn classifies(path: &str, candidate: &str) -> bool {
    if let Some((prefix, _)) = path.split_once("/*") {
        return candidate
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'));
    }
    let registered: Vec<&str> = path.split('/').collect();
    let classified: Vec<&str> = candidate.split('/').collect();
    registered.len() == classified.len()
        && registered
            .iter()
            .zip(&classified)
            .all(|(segment, concrete)| segment.starts_with(':') || segment == concrete)
}

struct PublicRouter<'a> {
    /// The module that owns the router and is merged by `vault_public_routes()`.
    module: &'a str,
    source: &'a str,
    function: &'a str,
    routes: usize,
}

/// The seven routers `vault_public_routes()` merges, each with its source.
fn public_routers() -> [PublicRouter<'static>; 7] {
    [
        PublicRouter {
            module: "vault_engines_api",
            source: include_str!("vault_engines_api.rs"),
            function: "fn public_routes()",
            routes: 12,
        },
        PublicRouter {
            module: "vault_broker_api",
            source: include_str!("vault_broker_api.rs"),
            function: "fn public_routes()",
            routes: 6,
        },
        PublicRouter {
            module: "vault_totp_pwpolicy_api",
            source: include_str!("vault_totp_pwpolicy_api.rs"),
            function: "fn public_routes()",
            routes: 3,
        },
        PublicRouter {
            module: "vault_crypto_api",
            source: include_str!("vault_crypto_api.rs"),
            function: "fn public_routes()",
            routes: 3,
        },
        PublicRouter {
            module: "vault_seal_dynamic_api",
            source: include_str!("vault_seal_dynamic_api.rs"),
            function: "fn public_routes()",
            routes: 3,
        },
        PublicRouter {
            module: "vault_tokens_api",
            source: include_str!("vault_tokens_api.rs"),
            function: "fn public_routes()",
            routes: 9,
        },
        PublicRouter {
            module: "vault_compat_api",
            source: include_str!("vault_compat_api.rs"),
            function: "fn router_with<",
            routes: 9,
        },
    ]
}

/// The routers `vault_public_routes()` merges, read from the source of
/// `server/mod.rs` (`.merge(<module>::public_routes())` in the function body).
fn merged_public_router_modules(mod_source: &str) -> Vec<String> {
    let header = "fn vault_public_routes() -> Router<ServerState> {";
    let start = mod_source
        .find(header)
        .unwrap_or_else(|| panic!("{header} is missing from server/mod.rs"));
    let rest = &mod_source[start..];
    let body = &rest[..rest.find("\n}\n").expect("the end of vault_public_routes")];
    body.match_indices(".merge(")
        .map(|(index, _)| {
            let call = &body[index + ".merge(".len()..];
            let call = &call[..call.find(')').expect("a closing parenthesis")];
            call.strip_suffix("::public_routes(")
                .unwrap_or(call)
                .to_owned()
        })
        .collect()
}

/// `vault_public_routes()` must merge exactly the routers this file scans. A
/// router merged there but not scanned would add public routes with no refusal
/// case, and the per-router scan below would never see it.
fn check_public_router_merges(mod_source: &str) -> Result<(), String> {
    let mut merged = merged_public_router_modules(mod_source);
    let mut scanned: Vec<String> = public_routers()
        .iter()
        .map(|router| router.module.to_owned())
        .collect();
    merged.sort();
    scanned.sort();
    if merged == scanned {
        return Ok(());
    }
    Err(format!(
        "vault_public_routes() merges {merged:?} but this file scans {scanned:?}; \
         scan the new router and classify its routes in this file"
    ))
}

#[test]
fn vault_public_routes_merges_exactly_the_routers_this_file_scans() {
    let mod_source = include_str!("mod.rs");
    assert_eq!(merged_public_router_modules(mod_source).len(), 7);
    check_public_router_merges(mod_source).unwrap();
}

#[test]
fn the_merge_check_notices_a_router_added_dropped_or_renamed() {
    let mod_source = include_str!("mod.rs");
    let crypto = ".merge(vault_crypto_api::public_routes())";
    assert_eq!(mod_source.matches(crypto).count(), 1);
    let added = mod_source.replace(
        crypto,
        &format!("{crypto}\n        .merge(vault_new_api::public_routes())"),
    );
    let dropped = mod_source.replace(crypto, "");
    let renamed = mod_source.replace(crypto, ".merge(vault_crypto_v2_api::public_routes())");
    let anonymous = mod_source.replace(crypto, &format!("{crypto}\n        .merge(Router::new())"));
    for (label, mutated) in [
        ("added", added),
        ("dropped", dropped),
        ("renamed", renamed),
        ("anonymous", anonymous),
    ] {
        let error = check_public_router_merges(&mutated)
            .expect_err(&format!("a {label} merge went unnoticed"));
        assert!(error.contains("scan the new router"), "{label}: {error}");
    }
}

/// A route added to a public vault router must be classified here, so it
/// cannot join the public side without a refusal case.
#[test]
fn every_public_vault_route_is_classified_in_this_file() {
    let routers = public_routers();
    let mut classified: Vec<&str> = ROUTES.iter().map(|route| route.pattern).collect();
    classified.extend(LOGIN_PATHS);
    classified.extend(COMPAT_LOGIN_PATHS);
    classified.extend(WRAP_PATHS);
    classified.extend(PUBLIC_BY_DESIGN);

    for router in routers {
        let start = router
            .source
            .find(router.function)
            .unwrap_or_else(|| panic!("{} is missing", router.function));
        let rest = &router.source[start..];
        let body = &rest[..rest.find("\n}\n").expect("the end of the router")];
        let mut registered = 0;
        for (index, _) in body.match_indices(".route(") {
            registered += 1;
            let after = body[index + ".route(".len()..].trim_start();
            let path = if let Some(quoted) = after.strip_prefix('"') {
                Some(quoted[..quoted.find('"').expect("a closing quote")].to_owned())
            } else if after.starts_with("CA_PATH") {
                Some(CA_PATH.to_owned())
            } else {
                None
            };
            if let Some(path) = path {
                assert!(
                    classified
                        .iter()
                        .any(|candidate| classifies(&path, candidate)),
                    "{path} is a public vault route with no refusal case in this file"
                );
            }
        }
        assert_eq!(
            registered, router.routes,
            "the public router in `{}` changed; classify the new route in this file",
            router.function
        );
    }
}
