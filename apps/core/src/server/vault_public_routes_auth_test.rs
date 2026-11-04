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
/// returns `false` so the caller has nothing left to do. `module` is the
/// caller's `module_path!()`, which names the child test exactly.
///
/// `test` is spelled out at each call site, and a name that matches no test
/// makes libtest run nothing and exit 0. The child's own report must therefore
/// say that exactly one test ran and passed, or a renamed function, a moved
/// module or a typo would leave its isolated case asserting nothing.
fn in_isolated_process(module: &str, test: &str) -> bool {
    if std::env::var_os(ISOLATED_CHILD_ENV).is_some() {
        return true;
    }
    let data_dir = tempfile::tempdir().expect("a data directory for the child");
    let output = std::process::Command::new(std::env::current_exe().expect("the test binary"))
        .args([
            "--exact",
            &format!(
                "{}::{test}",
                module.split_once("::").map_or(module, |(_, path)| path)
            ),
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
/// the server sources (`.merge(<module>::public_routes())` in the function body).
fn merged_public_router_modules(mod_source: &str) -> Vec<String> {
    let header = "fn vault_public_routes() -> Router<ServerState> {";
    let start = mod_source
        .find(header)
        .unwrap_or_else(|| panic!("{header} is missing from the server sources"));
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

#[path = "vault_public_routes_auth_test/fixtures_test.rs"]
mod fixtures;
use fixtures::*;

#[path = "vault_public_routes_auth_test/native_refuse_test.rs"]
mod native_refuse;
#[path = "vault_public_routes_auth_test/public_vault_test.rs"]
mod public_vault;
#[path = "vault_public_routes_auth_test/token_refuse_test.rs"]
mod token_refuse;
