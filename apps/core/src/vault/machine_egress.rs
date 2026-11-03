//! Egress screening for machine identities written by a delegate.
//!
//! A `jwt` identity's `jwksUrl` and a `kubernetes` identity's API server
//! `host` are URLs Core calls with its own network position whenever anyone
//! presents a login. Configuration managers (and the unbound local operator)
//! may point them anywhere, including this host's loopback and LAN. A
//! principal that holds only `admin` on `sys/machines` (a delegate) must not
//! borrow that position, so each identity records its writer, exactly like a
//! dynamic or static role (see [`target_guard`]):
//!
//! * at create, a delegate's `jwksUrl` or `host` must name a public host, and a
//!   delegate's `kubernetes` identity may not supply its own `caPem`;
//! * at every login, a delegate-written identity's JWKS fetch and TokenReview
//!   call are https-only, resolved, screened to public addresses, pinned, sent
//!   without a proxy, and never follow a redirect.
//!
//! A `kubernetes` identity whose `reviewerJwtEnv` is set already goes only to
//! the API server the operator pinned for that reviewer, so it keeps that
//! operator-chosen destination. Rows written before the writer was recorded
//! follow [`target_guard::row_egress`]: trusted on an unbound node, screened
//! (and stamped `delegate`) on a bound one; recreating the identity as a
//! configuration manager restores it.

use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use rusqlite::{Connection, OptionalExtension};
use serde_json::{json, Value};

use super::auth_methods::KubernetesAuthConfig;
use super::dynamic::target_guard::{self, RoleWriter, TargetEgress, WRITER_COLUMN};
use super::machine::AuthMethod;
use crate::plugin_secrets::PluginSecretStore;

const TABLE: &str = "vault_machine_identities";
const MAX_RESPONSE_BYTES: u64 = 1024 * 1024;
const JWKS_TIMEOUT: Duration = Duration::from_secs(10);
const TOKEN_REVIEW_TIMEOUT: Duration = Duration::from_secs(15);

fn refused(error: impl std::fmt::Display) -> anyhow::Error {
    anyhow!("{error} (machine identities created by a delegated admin may only reach public hosts)")
}

/// Add the writer column to an identity table created by an earlier release.
pub(crate) fn ensure_writer_column(conn: &Connection) -> Result<()> {
    target_guard::ensure_writer_column(conn, TABLE)
}

fn precheck_url(raw: &str, field: &str) -> Result<()> {
    let url = url::Url::parse(raw.trim()).with_context(|| format!("{field} is not a URL"))?;
    if url.scheme() != "https" {
        bail!("{field} must be https");
    }
    let host = url.host_str().unwrap_or_default();
    ryu_egress::target::screen_host_literal(host).map_err(refused)
}

/// Create-time screen of an identity's outbound targets for `writer`.
pub(super) fn precheck(auth: &AuthMethod, writer: RoleWriter) -> Result<()> {
    if writer == RoleWriter::Manager {
        return Ok(());
    }
    match auth {
        AuthMethod::Jwt(config) => match &config.jwks_url {
            Some(url) => precheck_url(url, "jwksUrl"),
            None => Ok(()),
        },
        // The operator's reviewer pin already fixes the destination.
        AuthMethod::Kubernetes(config) if config.reviewer_jwt_env.is_some() => Ok(()),
        AuthMethod::Kubernetes(config) => {
            if config.ca_pem.is_some() {
                return Err(refused("caPem is not allowed"));
            }
            precheck_url(&config.host, "host")
        }
        AuthMethod::AppRole { .. } | AuthMethod::Cert(_) | AuthMethod::AwsIam(_) => Ok(()),
    }
}

impl PluginSecretStore {
    /// The egress an identity's writer earned. An unrecorded row used on a
    /// bound node is stamped `delegate` first.
    pub(super) async fn machine_identity_egress(&self, name: &str) -> Result<TargetEgress> {
        let conn = self.conn.lock().await;
        let writer: Option<String> = conn
            .query_row(
                &format!("SELECT {WRITER_COLUMN} FROM {TABLE} WHERE name = ?1"),
                [name],
                |row| row.get(0),
            )
            .optional()?
            .flatten();
        target_guard::row_egress(&conn, TABLE, name, writer.as_deref())
    }
}

fn screened_policy(timeout: Duration) -> ryu_egress::GuardedFetchPolicy {
    ryu_egress::GuardedFetchPolicy {
        allow_http: false,
        max_body_bytes: MAX_RESPONSE_BYTES,
        max_redirect_hops: 0,
        timeout,
    }
}

/// Fetch a JWKS document. Redirects are never followed; a screened fetch is
/// also public-only, pinned, and proxy-free.
pub(super) async fn fetch_jwks(
    url: &str,
    egress: TargetEgress,
) -> Result<jsonwebtoken::jwk::JwkSet> {
    if egress == TargetEgress::Trusted {
        return reqwest::Client::builder()
            .timeout(JWKS_TIMEOUT)
            .redirect(reqwest::redirect::Policy::none())
            .build()?
            .get(url)
            .send()
            .await?
            .error_for_status()?
            .json()
            .await
            .context("parsing JWKS");
    }
    let request = ryu_egress::GuardedRequest {
        method: "GET".to_owned(),
        url: url.to_owned(),
        headers: vec![("accept".to_owned(), "application/json".to_owned())],
        body: None,
    };
    let response = ryu_egress::guarded_request_direct(request, screened_policy(JWKS_TIMEOUT))
        .await
        .map_err(refused)?;
    if !(200..300).contains(&response.status) {
        bail!("the JWKS endpoint returned {}", response.status);
    }
    serde_json::from_slice(&response.body).context("parsing JWKS")
}

/// A delegate's TokenReview call (no reviewer pin): the client's JWT goes to
/// a public API server only, with the platform trust store.
pub(super) async fn token_review_screened(
    config: &KubernetesAuthConfig,
    jwt: &str,
) -> Result<Value> {
    if config.ca_pem.is_some() {
        return Err(refused("caPem is not allowed"));
    }
    let origin = super::auth_methods::api_server_origin(&config.host)?;
    let body = serde_json::to_vec(&json!({
        "apiVersion": "authentication.k8s.io/v1",
        "kind": "TokenReview",
        "spec": { "token": jwt, "audiences": config.audiences },
    }))?;
    let request = ryu_egress::GuardedRequest {
        method: "POST".to_owned(),
        url: format!("{origin}/apis/authentication.k8s.io/v1/tokenreviews"),
        headers: vec![
            ("authorization".to_owned(), format!("Bearer {}", jwt.trim())),
            ("content-type".to_owned(), "application/json".to_owned()),
        ],
        body: Some(body),
    };
    let response =
        ryu_egress::guarded_request_direct(request, screened_policy(TOKEN_REVIEW_TIMEOUT))
            .await
            .map_err(refused)?;
    if !(200..300).contains(&response.status) {
        bail!(
            "the Kubernetes TokenReview API returned {}",
            response.status
        );
    }
    serde_json::from_slice(&response.body)
        .context("the Kubernetes TokenReview API returned invalid JSON")
}

#[cfg(test)]
#[path = "machine_egress_test.rs"]
mod tests;
