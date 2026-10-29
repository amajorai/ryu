//! Extra machine auth methods: TLS certificates, AWS IAM, and Kubernetes.
//!
//! These extend [`super::machine`] (AppRole and OIDC/JWT) with the methods
//! HashiCorp Vault and OpenBao offer for keyless machine login. Each one is a
//! variant of [`super::machine::AuthMethod`], so identities are created,
//! listed, disabled, and bound to policies exactly like the existing ones, and
//! a successful login issues the same short-lived `rvt_…` token.
//!
//! * **cert**: the client presents its certificate (PEM) and a short-lived
//!   proof-of-possession JWT signed with the certificate's private key
//!   (`aud` = [`CERT_LOGIN_AUDIENCE`], `sub` = the identity name, lifetime at
//!   most five minutes, unique `jti`). Core checks the certificate's validity
//!   window, that one of the configured CA certificates signed it, that its
//!   Extended Key Usage (when present) allows client authentication, that the
//!   PKI engine has not revoked its serial, and that its common name or a
//!   DNS/URI SAN matches the identity's globs. Pairs with the PKI engine: mesh
//!   nodes and sandboxes log in with a Ryu-issued cert.
//! * **aws-iam**: the client signs an `sts:GetCallerIdentity` request with its
//!   own AWS credentials and sends the method, URL, body, and headers
//!   (base64; the same fields as HashiCorp Vault's `iam_*` login parameters,
//!   accepted in camelCase or snake_case). Core accepts only that exact STS
//!   call against an AWS STS host, requires a signed `X-Ryu-Server-ID` header
//!   (replay protection across servers), forwards it
//!   to STS, and binds the returned ARN (assumed-role ARNs also match their
//!   `iam::…:role/…` form) against the identity's ARN globs.
//! * **kubernetes**: the client sends its service-account JWT; Core asks the
//!   cluster's `TokenReview` API whether it is valid, then binds the service
//!   account's namespace and name. The reviewer credential is the client's own
//!   JWT unless the identity names an env var holding a reviewer token; that
//!   variable must carry the reserved [`K8S_REVIEWER_ENV_PREFIX`] so an
//!   identity can never point Core at another secret in its environment, and
//!   the operator must pin the API server it may be sent to in the matching
//!   [`K8S_HOST_ENV_PREFIX`] variable, so an identity cannot redirect the
//!   reviewer token to another host. No cluster credential is stored in the
//!   vault database.
//!
//! Globs follow the policy grammar ([`super::policy::glob_matches`]).

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use super::audit::{AuditActor, AuditEntry};
use super::machine::{AuthMethod, IssuedToken, MachineIdentity};
use super::{now_millis, VaultError};
use crate::plugin_secrets::PluginSecretStore;

/// `aud` of a certificate proof-of-possession JWT.
pub const CERT_LOGIN_AUDIENCE: &str = "ryu-vault-cert-login";
/// Longest accepted proof-of-possession lifetime.
const CERT_PROOF_MAX_SECS: i64 = 300;
/// Header carrying the configured server id in signed STS requests.
pub const AWS_SERVER_ID_HEADER: &str = "x-ryu-server-id";
/// Required prefix of a Kubernetes `reviewerJwtEnv` variable name.
pub const K8S_REVIEWER_ENV_PREFIX: &str = "RYU_VAULT_K8S_REVIEWER_";
/// Prefix of the operator-set variable pinning the API server a reviewer
/// token may be sent to: `RYU_VAULT_K8S_REVIEWER_<NAME>` is only ever sent to
/// the URL in `RYU_VAULT_K8S_HOST_<NAME>`.
pub const K8S_HOST_ENV_PREFIX: &str = "RYU_VAULT_K8S_HOST_";
const DEFAULT_STS_URL: &str = "https://sts.amazonaws.com/";
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);
const MAX_PEM_BYTES: usize = 64 * 1024;

fn any_glob(patterns: &[String], value: &str) -> bool {
    patterns
        .iter()
        .any(|pattern| super::policy::glob_matches(pattern, value))
}

fn require_patterns(patterns: &[String], field: &str) -> Result<()> {
    if patterns.iter().any(|pattern| pattern.trim().is_empty()) {
        bail!("{field} must not contain empty patterns");
    }
    Ok(())
}

// ── TLS certificate ───────────────────────────────────────────────────────

/// `cert` login configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CertAuthConfig {
    /// One or more PEM CA certificates; the client certificate must be
    /// signed directly by one of them.
    pub ca_pem: String,
    /// Allowed subject common names (globs).
    #[serde(default)]
    pub allowed_common_names: Vec<String>,
    /// Allowed DNS SANs (globs).
    #[serde(default)]
    pub allowed_dns_sans: Vec<String>,
    /// Allowed URI SANs (globs).
    #[serde(default)]
    pub allowed_uri_sans: Vec<String>,
}

fn parse_pems(text: &str) -> Result<Vec<x509_parser::pem::Pem>> {
    if text.len() > MAX_PEM_BYTES {
        bail!("PEM input is too large");
    }
    let mut out = Vec::new();
    for pem in x509_parser::pem::Pem::iter_from_buffer(text.as_bytes()) {
        let pem = pem.map_err(|_| anyhow!("invalid PEM block"))?;
        if pem.label == "CERTIFICATE" {
            out.push(pem);
        }
    }
    if out.is_empty() {
        bail!("no PEM certificate found");
    }
    Ok(out)
}

impl CertAuthConfig {
    fn validate(&self) -> Result<()> {
        let pems = parse_pems(&self.ca_pem).context("caPem")?;
        for pem in &pems {
            let ca = pem
                .parse_x509()
                .map_err(|_| anyhow!("caPem holds an invalid certificate"))?;
            if !ca.is_ca() {
                bail!("caPem certificates must be CA certificates");
            }
        }
        require_patterns(&self.allowed_common_names, "allowedCommonNames")?;
        require_patterns(&self.allowed_dns_sans, "allowedDnsSans")?;
        require_patterns(&self.allowed_uri_sans, "allowedUriSans")?;
        if self.allowed_common_names.is_empty()
            && self.allowed_dns_sans.is_empty()
            && self.allowed_uri_sans.is_empty()
        {
            // The CA alone admits every certificate it ever issued.
            bail!("set allowedCommonNames, allowedDnsSans, or allowedUriSans");
        }
        Ok(())
    }
}

/// Names presented by a verified client certificate.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct CertNames {
    pub common_names: Vec<String>,
    pub dns_sans: Vec<String>,
    pub uri_sans: Vec<String>,
    /// Lowercase hex serial (the PKI engine's `vault_pki_certs.serial` form).
    pub serial: String,
}

/// Verify `cert_pem` against `config` (validity, issuing CA, names). Returns
/// the certificate's SPKI as a PEM `PUBLIC KEY` and its names.
pub fn verify_client_cert(config: &CertAuthConfig, cert_pem: &str) -> Result<(String, CertNames)> {
    use x509_parser::extensions::GeneralName;
    let leaf_pems = parse_pems(cert_pem)?;
    let leaf = leaf_pems[0]
        .parse_x509()
        .map_err(|_| anyhow!("the client certificate is invalid"))?;
    if !leaf.validity().is_valid() {
        bail!("the client certificate is expired or not yet valid");
    }
    if leaf.is_ca() {
        bail!("a CA certificate cannot log in");
    }
    match leaf.extended_key_usage() {
        Ok(None) => {}
        Ok(Some(eku)) if eku.value.client_auth || eku.value.any => {}
        Ok(Some(_)) => bail!("the client certificate is not valid for client authentication"),
        Err(_) => bail!("the client certificate has an invalid Extended Key Usage"),
    }
    let ca_pems = parse_pems(&config.ca_pem)?;
    let mut trusted = false;
    for pem in &ca_pems {
        let Ok(ca) = pem.parse_x509() else { continue };
        if ca.subject().as_raw() != leaf.issuer().as_raw() || !ca.validity().is_valid() {
            continue;
        }
        if leaf.verify_signature(Some(ca.public_key())).is_ok() {
            trusted = true;
            break;
        }
    }
    if !trusted {
        bail!("the client certificate was not issued by a trusted CA");
    }
    let mut names = CertNames {
        common_names: leaf
            .subject()
            .iter_common_name()
            .filter_map(|attribute| attribute.as_str().ok().map(str::to_owned))
            .collect(),
        serial: hex::encode(leaf.raw_serial()),
        ..CertNames::default()
    };
    if let Ok(Some(san)) = leaf.subject_alternative_name() {
        for name in &san.value.general_names {
            match name {
                GeneralName::DNSName(dns) => names.dns_sans.push((*dns).to_owned()),
                GeneralName::URI(uri) => names.uri_sans.push((*uri).to_owned()),
                _ => {}
            }
        }
    }
    let matched = names
        .common_names
        .iter()
        .any(|cn| any_glob(&config.allowed_common_names, cn))
        || names
            .dns_sans
            .iter()
            .any(|dns| any_glob(&config.allowed_dns_sans, dns))
        || names
            .uri_sans
            .iter()
            .any(|uri| any_glob(&config.allowed_uri_sans, uri));
    if !matched {
        bail!("the client certificate's names are not allowed for this identity");
    }
    let spki = base64::engine::general_purpose::STANDARD.encode(leaf.public_key().raw);
    let mut pem = String::from("-----BEGIN PUBLIC KEY-----\n");
    for chunk in spki.as_bytes().chunks(64) {
        pem.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        pem.push('\n');
    }
    pem.push_str("-----END PUBLIC KEY-----\n");
    Ok((pem, names))
}

/// Seen proof-of-possession ids (`jti`) with their expiry, so a captured
/// proof cannot be replayed inside its short lifetime.
fn seen_proofs() -> &'static Mutex<HashMap<String, i64>> {
    static SEEN: OnceLock<Mutex<HashMap<String, i64>>> = OnceLock::new();
    SEEN.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Verify the proof-of-possession JWT against the certificate key.
pub fn verify_cert_proof(public_key_pem: &str, identity_name: &str, proof: &str) -> Result<()> {
    use jsonwebtoken::{decode, decode_header, Algorithm, DecodingKey, Validation};
    let header = decode_header(proof).map_err(|_| anyhow!("malformed proof JWT"))?;
    let key = match header.alg {
        Algorithm::HS256 | Algorithm::HS384 | Algorithm::HS512 => {
            bail!("symmetric proof algorithms are not accepted")
        }
        Algorithm::ES256 | Algorithm::ES384 => DecodingKey::from_ec_pem(public_key_pem.as_bytes())?,
        Algorithm::EdDSA => DecodingKey::from_ed_pem(public_key_pem.as_bytes())?,
        _ => DecodingKey::from_rsa_pem(public_key_pem.as_bytes())?,
    };
    let mut validation = Validation::new(header.alg);
    validation.set_audience(&[CERT_LOGIN_AUDIENCE]);
    validation.sub = Some(identity_name.to_owned());
    validation.set_required_spec_claims(&["exp", "aud", "sub", "iat"]);
    validation.leeway = 30;
    let claims = decode::<Value>(proof, &key, &validation)
        .map_err(|error| anyhow!("proof JWT rejected: {error}"))?
        .claims;
    let iat = claims.get("iat").and_then(Value::as_i64).unwrap_or(0);
    let exp = claims.get("exp").and_then(Value::as_i64).unwrap_or(0);
    let now = now_millis() / 1000;
    if exp - iat > CERT_PROOF_MAX_SECS || iat > now + 30 {
        bail!("proof JWT lifetime must be at most {CERT_PROOF_MAX_SECS} seconds");
    }
    let jti = claims
        .get("jti")
        .and_then(Value::as_str)
        .filter(|jti| !jti.is_empty() && jti.len() <= 128)
        .ok_or_else(|| anyhow!("proof JWT needs a jti"))?;
    let mut seen = seen_proofs()
        .lock()
        .unwrap_or_else(|poison| poison.into_inner());
    seen.retain(|_, expires| *expires + 60 >= now);
    let replay_key = format!("{identity_name}:{jti}");
    if seen.contains_key(&replay_key) {
        bail!("proof JWT was already used");
    }
    seen.insert(replay_key, exp);
    Ok(())
}

// ── AWS IAM ───────────────────────────────────────────────────────────────

/// `aws-iam` login configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsIamAuthConfig {
    /// Allowed caller ARNs (globs), e.g.
    /// `arn:aws:iam::123456789012:role/ci-*`. An assumed-role session ARN
    /// also matches as its `iam::…:role/<name>` form.
    pub bound_iam_principal_arns: Vec<String>,
    /// Value the client must sign into `X-Ryu-Server-ID`, so a request
    /// signed for another server cannot be replayed here. Required: an
    /// identity without it would accept any captured `GetCallerIdentity`.
    #[serde(default)]
    pub server_id_header_value: Option<String>,
    /// STS endpoint (default `https://sts.amazonaws.com/`); must be an AWS
    /// STS host.
    #[serde(default)]
    pub sts_endpoint: Option<String>,
}

fn is_sts_host(host: &str) -> bool {
    let Some(rest) = host.strip_prefix("sts.") else {
        return false;
    };
    let rest = rest
        .strip_suffix(".amazonaws.com.cn")
        .or_else(|| rest.strip_suffix(".amazonaws.com"))
        .or_else(|| (rest == "amazonaws.com").then_some(""));
    match rest {
        Some("") => true,
        Some(region) => region
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
        None => false,
    }
}

impl AwsIamAuthConfig {
    fn endpoint(&self) -> &str {
        self.sts_endpoint.as_deref().unwrap_or(DEFAULT_STS_URL)
    }

    fn validate(&self) -> Result<()> {
        if self.bound_iam_principal_arns.is_empty() {
            bail!("boundIamPrincipalArns must not be empty");
        }
        require_patterns(&self.bound_iam_principal_arns, "boundIamPrincipalArns")?;
        if self
            .bound_iam_principal_arns
            .iter()
            .any(|arn| !arn.starts_with("arn:"))
        {
            bail!("boundIamPrincipalArns entries must be ARNs");
        }
        let url = url::Url::parse(self.endpoint()).context("stsEndpoint is not a URL")?;
        if url.scheme() != "https" || !url.host_str().is_some_and(is_sts_host) {
            bail!("stsEndpoint must be an https AWS STS endpoint");
        }
        if self
            .server_id_header_value
            .as_deref()
            .is_none_or(|value| value.trim().is_empty())
        {
            bail!("serverIdHeaderValue is required (replay protection across servers)");
        }
        Ok(())
    }
}

/// The signed STS request a client presents: HashiCorp Vault's `iam_*`
/// login fields, in camelCase (snake_case is accepted as an alias).
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AwsIamLogin {
    #[serde(default = "default_post", alias = "iam_http_request_method")]
    pub iam_http_request_method: String,
    /// Base64 request URL.
    #[serde(alias = "iam_request_url")]
    pub iam_request_url: String,
    /// Base64 form body.
    #[serde(alias = "iam_request_body")]
    pub iam_request_body: String,
    /// Base64 JSON object of headers (string or string-array values).
    #[serde(alias = "iam_request_headers")]
    pub iam_request_headers: String,
}

fn default_post() -> String {
    "POST".to_owned()
}

/// A validated STS request ready to forward.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StsRequest {
    pub url: String,
    pub body: String,
    pub headers: Vec<(String, String)>,
}

fn b64_text(value: &str, field: &str) -> Result<String> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(value.trim())
        .map_err(|_| anyhow!("{field} is not valid base64"))?;
    String::from_utf8(bytes).map_err(|_| anyhow!("{field} is not UTF-8"))
}

/// Check that `login` is exactly a signed `GetCallerIdentity` against the
/// configured STS endpoint.
pub fn validate_sts_request(config: &AwsIamAuthConfig, login: &AwsIamLogin) -> Result<StsRequest> {
    if !login.iam_http_request_method.eq_ignore_ascii_case("POST") {
        bail!("only POST GetCallerIdentity requests are accepted");
    }
    let url = b64_text(&login.iam_request_url, "iamRequestUrl")?;
    let parsed = url::Url::parse(&url).map_err(|_| anyhow!("iamRequestUrl is not a URL"))?;
    let expected = url::Url::parse(config.endpoint())?;
    if parsed.scheme() != "https"
        || parsed.host_str() != expected.host_str()
        || parsed.port_or_known_default() != expected.port_or_known_default()
        || !matches!(parsed.path(), "" | "/")
        || parsed.query().is_some()
    {
        bail!("iamRequestUrl must be the configured STS endpoint");
    }
    let body = b64_text(&login.iam_request_body, "iamRequestBody")?;
    let mut pairs: Vec<(String, String)> = url::form_urlencoded::parse(body.as_bytes())
        .map(|(key, value)| (key.into_owned(), value.into_owned()))
        .collect();
    pairs.sort();
    if pairs
        != [
            ("Action".to_owned(), "GetCallerIdentity".to_owned()),
            ("Version".to_owned(), "2011-06-15".to_owned()),
        ]
    {
        bail!("iamRequestBody must be exactly Action=GetCallerIdentity&Version=2011-06-15");
    }
    let raw_headers: Value =
        serde_json::from_str(&b64_text(&login.iam_request_headers, "iamRequestHeaders")?)
            .map_err(|_| anyhow!("iamRequestHeaders is not a JSON object"))?;
    let object = raw_headers
        .as_object()
        .ok_or_else(|| anyhow!("iamRequestHeaders is not a JSON object"))?;
    let mut headers = Vec::new();
    for (name, value) in object {
        let lower = name.to_ascii_lowercase();
        // Hop-by-hop and length headers are recomputed by the client.
        if matches!(
            lower.as_str(),
            "host" | "content-length" | "connection" | "transfer-encoding"
        ) {
            continue;
        }
        let joined = match value {
            Value::String(text) => text.clone(),
            Value::Array(items) => items
                .iter()
                .filter_map(Value::as_str)
                .collect::<Vec<_>>()
                .join(","),
            _ => bail!("header `{name}` has a non-string value"),
        };
        if joined.contains(['\r', '\n']) {
            bail!("header `{name}` contains a line break");
        }
        headers.push((lower, joined));
    }
    let header = |name: &str| {
        headers
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    };
    let authorization = header("authorization")
        .filter(|value| value.starts_with("AWS4-HMAC-SHA256 "))
        .ok_or_else(|| anyhow!("the STS request is not SigV4-signed"))?;
    // `validate` requires the server id; fail closed for a legacy row too.
    let expected = config
        .server_id_header_value
        .as_deref()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("this identity has no serverIdHeaderValue"))?;
    {
        if header(AWS_SERVER_ID_HEADER) != Some(expected) {
            bail!("the STS request does not carry the expected X-Ryu-Server-ID");
        }
        let signed = authorization
            .split("SignedHeaders=")
            .nth(1)
            .and_then(|rest| rest.split([',', ' ']).next())
            .unwrap_or_default();
        if !signed
            .split(';')
            .any(|name| name.eq_ignore_ascii_case(AWS_SERVER_ID_HEADER))
        {
            bail!("X-Ryu-Server-ID must be a signed header");
        }
    }
    Ok(StsRequest { url, body, headers })
}

fn xml_text<'a>(xml: &'a str, tag: &str) -> Option<&'a str> {
    let open = format!("<{tag}>");
    let close = format!("</{tag}>");
    let start = xml.find(&open)? + open.len();
    let end = xml[start..].find(&close)? + start;
    Some(xml[start..end].trim())
}

/// `arn:aws:sts::ACCT:assumed-role/ROLE/SESSION` → `arn:aws:iam::ACCT:role/ROLE`.
pub fn canonical_role_arn(arn: &str) -> Option<String> {
    let mut parts = arn.splitn(6, ':');
    let (Some("arn"), Some(partition), Some("sts"), Some(_), Some(account), Some(resource)) = (
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
        parts.next(),
    ) else {
        return None;
    };
    let role = resource.strip_prefix("assumed-role/")?.split('/').next()?;
    Some(format!("arn:{partition}:iam::{account}:role/{role}"))
}

/// Whether the STS caller `arn` matches the identity's ARN globs.
pub fn arn_allowed(config: &AwsIamAuthConfig, arn: &str) -> bool {
    any_glob(&config.bound_iam_principal_arns, arn)
        || canonical_role_arn(arn)
            .is_some_and(|role| any_glob(&config.bound_iam_principal_arns, &role))
}

async fn call_sts(request: &StsRequest) -> Result<String> {
    // The URL was pinned to an STS host; never follow a redirect elsewhere.
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let mut builder = client
        .post(&request.url)
        .timeout(HTTP_TIMEOUT)
        .body(request.body.clone());
    for (name, value) in &request.headers {
        builder = builder.header(name.as_str(), value.as_str());
    }
    let response = builder.send().await.context("calling AWS STS")?;
    let status = response.status();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        bail!("AWS STS rejected the signed request ({status})");
    }
    xml_text(&text, "Arn")
        .map(str::to_owned)
        .ok_or_else(|| anyhow!("AWS STS returned no caller ARN"))
}

// ── Kubernetes ────────────────────────────────────────────────────────────

/// `kubernetes` login configuration.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct KubernetesAuthConfig {
    /// API server URL, e.g. `https://10.0.0.1:6443`.
    pub host: String,
    /// PEM CA for the API server (the platform trust store otherwise).
    #[serde(default)]
    pub ca_pem: Option<String>,
    /// Env var holding a reviewer token with `system:auth-delegator`; it must
    /// start with [`K8S_REVIEWER_ENV_PREFIX`]. When unset, the client's own
    /// JWT is the reviewer credential.
    #[serde(default)]
    pub reviewer_jwt_env: Option<String>,
    /// Allowed service-account names (globs).
    pub bound_service_account_names: Vec<String>,
    /// Allowed namespaces (globs).
    pub bound_service_account_namespaces: Vec<String>,
    /// Audiences to request in the TokenReview.
    #[serde(default)]
    pub audiences: Vec<String>,
}

impl KubernetesAuthConfig {
    fn validate(&self) -> Result<()> {
        let url = url::Url::parse(&self.host).context("host is not a URL")?;
        if url.scheme() != "https" {
            bail!("host must be https");
        }
        if let Some(pem) = &self.ca_pem {
            reqwest::Certificate::from_pem(pem.as_bytes())
                .context("caPem is not a PEM certificate")?;
        }
        if let Some(env) = &self.reviewer_jwt_env {
            check_reviewer_env(env)?;
            check_reviewer_host(env, &self.host)?;
        }
        if self.bound_service_account_names.is_empty()
            || self.bound_service_account_namespaces.is_empty()
        {
            bail!("set boundServiceAccountNames and boundServiceAccountNamespaces");
        }
        require_patterns(
            &self.bound_service_account_names,
            "boundServiceAccountNames",
        )?;
        require_patterns(
            &self.bound_service_account_namespaces,
            "boundServiceAccountNamespaces",
        )?;
        Ok(())
    }
}

/// A `reviewerJwtEnv` name must be `RYU_VAULT_K8S_REVIEWER_<SUFFIX>`: the
/// value is sent as a bearer token to an admin-chosen host, so any other
/// variable (master key, node token, provider API keys) is off limits.
fn check_reviewer_env(env: &str) -> Result<()> {
    let suffix = env
        .strip_prefix(K8S_REVIEWER_ENV_PREFIX)
        .unwrap_or_default();
    if suffix.is_empty()
        || !suffix
            .bytes()
            .all(|b| b.is_ascii_uppercase() || b.is_ascii_digit() || b == b'_')
    {
        bail!(
            "reviewerJwtEnv must be an environment variable named {K8S_REVIEWER_ENV_PREFIX}<NAME>"
        );
    }
    Ok(())
}

/// `scheme://host:port/path` of an API server URL, for comparing a configured
/// host with the operator's pin. Credentials, queries, and fragments are
/// refused: the TokenReview path is appended to the host as text.
fn api_server_origin(host: &str) -> Result<String> {
    let url = url::Url::parse(host.trim()).context("host is not a URL")?;
    if url.scheme() != "https" {
        bail!("host must be https");
    }
    if !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("host must not carry credentials, a query, or a fragment");
    }
    let name = url
        .host_str()
        .ok_or_else(|| anyhow!("host must name a server"))?;
    let port = url
        .port_or_known_default()
        .ok_or_else(|| anyhow!("host has no port"))?;
    Ok(format!(
        "https://{}:{port}{}",
        name.trim_end_matches('.'),
        url.path().trim_end_matches('/')
    ))
}

/// A reviewer token is sent only to the API server the operator pinned for
/// it in `RYU_VAULT_K8S_HOST_<NAME>`: the identity's `host` (and `caPem`) are
/// chosen by whoever configures the identity, so without the pin they could
/// point Core at their own server and receive the reviewer token, or use it
/// against an internal endpoint.
fn check_reviewer_host(env: &str, host: &str) -> Result<()> {
    let suffix = env
        .strip_prefix(K8S_REVIEWER_ENV_PREFIX)
        .unwrap_or_default();
    let pin_env = format!("{K8S_HOST_ENV_PREFIX}{suffix}");
    let pinned = std::env::var(&pin_env)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            anyhow!("reviewerJwtEnv needs the API server pinned in `{pin_env}` before it is used")
        })?;
    let pinned = api_server_origin(&pinned).with_context(|| format!("`{pin_env}` is invalid"))?;
    if api_server_origin(host)? != pinned {
        bail!("host does not match the API server pinned in `{pin_env}` for `{env}`");
    }
    Ok(())
}

/// `(namespace, name)` from a TokenReview `system:serviceaccount:NS:NAME`.
pub fn service_account(username: &str) -> Option<(String, String)> {
    let rest = username.strip_prefix("system:serviceaccount:")?;
    let (namespace, name) = rest.split_once(':')?;
    if namespace.is_empty() || name.is_empty() || name.contains(':') {
        return None;
    }
    Some((namespace.to_owned(), name.to_owned()))
}

/// Interpret a TokenReview response against the identity's bindings.
pub fn check_token_review(
    config: &KubernetesAuthConfig,
    review: &Value,
) -> Result<(String, String)> {
    let status = review
        .get("status")
        .ok_or_else(|| anyhow!("TokenReview response has no status"))?;
    if status.get("authenticated").and_then(Value::as_bool) != Some(true) {
        let reason = status
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("not authenticated");
        bail!("the cluster rejected the token: {reason}");
    }
    let username = status
        .pointer("/user/username")
        .and_then(Value::as_str)
        .ok_or_else(|| anyhow!("TokenReview response has no username"))?;
    let (namespace, name) =
        service_account(username).ok_or_else(|| anyhow!("the token is not a service account"))?;
    if !config.audiences.is_empty() {
        let granted: Vec<&str> = status
            .get("audiences")
            .and_then(Value::as_array)
            .map(|items| items.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        if !config
            .audiences
            .iter()
            .any(|aud| granted.contains(&aud.as_str()))
        {
            bail!("the token is not valid for the configured audiences");
        }
    }
    if !any_glob(&config.bound_service_account_namespaces, &namespace) {
        bail!("namespace `{namespace}` is not allowed");
    }
    if !any_glob(&config.bound_service_account_names, &name) {
        bail!("service account `{name}` is not allowed");
    }
    Ok((namespace, name))
}

async fn token_review(config: &KubernetesAuthConfig, jwt: &str) -> Result<Value> {
    let reviewer = match &config.reviewer_jwt_env {
        Some(env) => std::env::var({
            // Re-checked at use: a row written before the prefix and host-pin
            // rules (or edited directly) must never read another variable or
            // send the token to an unpinned host.
            check_reviewer_env(env)?;
            check_reviewer_host(env, &config.host)?;
            env
        })
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| anyhow!("reviewer token env var `{env}` is not set"))?,
        None => jwt.to_owned(),
    };
    let mut client = reqwest::Client::builder()
        .timeout(HTTP_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none());
    if let Some(pem) = &config.ca_pem {
        client = client.add_root_certificate(reqwest::Certificate::from_pem(pem.as_bytes())?);
    }
    let url = format!(
        "{}/apis/authentication.k8s.io/v1/tokenreviews",
        config.host.trim_end_matches('/')
    );
    let response = client
        .build()?
        .post(url)
        .bearer_auth(reviewer.trim())
        .json(&json!({
            "apiVersion": "authentication.k8s.io/v1",
            "kind": "TokenReview",
            "spec": { "token": jwt, "audiences": config.audiences },
        }))
        .send()
        .await
        .context("calling the Kubernetes TokenReview API")?;
    let status = response.status();
    if !status.is_success() {
        bail!("the Kubernetes TokenReview API returned {status}");
    }
    response
        .json()
        .await
        .context("the Kubernetes TokenReview API returned invalid JSON")
}

// ── Shared ────────────────────────────────────────────────────────────────

/// Validate a `cert`, `aws-iam`, or `kubernetes` method at identity creation.
pub fn validate(method: &AuthMethod) -> Result<()> {
    match method {
        AuthMethod::Cert(config) => config.validate(),
        AuthMethod::AwsIam(config) => config.validate(),
        AuthMethod::Kubernetes(config) => config.validate(),
        AuthMethod::AppRole { .. } | AuthMethod::Jwt(_) => Ok(()),
    }
}

impl PluginSecretStore {
    /// Load an enabled identity of the expected method, auditing every
    /// rejection (unknown, disabled, or another method) as a denied login.
    pub(super) async fn login_identity(
        &self,
        identity_name: &str,
        action: &str,
        uses_method: fn(&AuthMethod) -> bool,
    ) -> Result<MachineIdentity> {
        let (actor_id, failure): (Option<String>, anyhow::Error) =
            match self.machine_get(identity_name).await {
                Err(error) => (None, error),
                Ok(identity) if identity.disabled => (
                    Some(identity.id),
                    VaultError::Denied("identity is disabled".into()).into(),
                ),
                Ok(identity) if !uses_method(&identity.auth) => (
                    Some(identity.id),
                    VaultError::Invalid(format!("identity does not use {action} login")).into(),
                ),
                // Like AppRole and JWT, a login from outside the identity's
                // boundCidrs is refused before any credential is verified.
                Ok(identity)
                    if !super::tokens::ip_allowed(
                        &identity.token_config.bound_cidrs,
                        super::tokens::request_client_ip(),
                    ) =>
                {
                    (
                        Some(identity.id),
                        VaultError::Denied("source address not allowed".into()).into(),
                    )
                }
                Ok(identity) => return Ok(identity),
            };
        self.audit(
            &AuditEntry::new(
                &AuditActor::new("machine", actor_id.as_deref()),
                &format!("auth.{action}.login"),
                "denied",
            )
            // The name comes from an unauthenticated caller; bound it.
            .details(json!({
                "identity": identity_name.chars().take(128).collect::<String>(),
                "reason": failure.to_string(),
            })),
        )
        .await;
        Err(failure)
    }

    /// Whether the PKI engine recorded `serial` (lowercase hex) as revoked.
    async fn pki_serial_revoked(&self, serial: &str) -> Result<bool> {
        use rusqlite::OptionalExtension as _;
        let conn = self.conn.lock().await;
        let revoked: Option<Option<i64>> = conn
            .query_row(
                "SELECT revoked_at FROM vault_pki_certs WHERE serial = ?1",
                rusqlite::params![serial],
                |row| row.get(0),
            )
            .optional()
            .context("checking certificate revocation")?;
        Ok(revoked.flatten().is_some())
    }

    async fn login_denied(&self, identity: &MachineIdentity, action: &str, error: &anyhow::Error) {
        self.audit(
            &AuditEntry::new(
                &AuditActor::new("machine", Some(&identity.id)),
                action,
                "denied",
            )
            .details(json!({ "reason": error.to_string() })),
        )
        .await;
    }

    async fn login_issue(
        &self,
        identity: &MachineIdentity,
        action: &str,
        details: Value,
    ) -> Result<IssuedToken> {
        let conn = self.conn.lock().await;
        let token = self.issue_token_locked(&conn, identity, None)?;
        let mut details = details;
        details["tokenAccessor"] = json!(token.accessor);
        if !self.audit_locked(
            &conn,
            &AuditEntry::new(
                &AuditActor::new("machine", Some(&identity.id)),
                action,
                "ok",
            )
            .details(details),
        ) {
            super::tokens::withhold_token_locked(&conn, &token.accessor)?;
            return Err(VaultError::AuditUnavailable.into());
        }
        Ok(token)
    }

    /// TLS certificate login with a proof-of-possession JWT.
    pub async fn cert_login(
        &self,
        identity_name: &str,
        certificate_pem: &str,
        proof: &str,
    ) -> Result<IssuedToken> {
        let identity = self
            .login_identity(identity_name, "cert", |auth| {
                matches!(auth, AuthMethod::Cert(_))
            })
            .await?;
        let AuthMethod::Cert(config) = &identity.auth else {
            return Err(VaultError::Invalid("identity does not use cert login".into()).into());
        };
        let verified = match verify_client_cert(config, certificate_pem) {
            Ok((key, names)) => match self.pki_serial_revoked(&names.serial).await {
                Ok(true) => Err(anyhow!("the client certificate has been revoked")),
                Ok(false) => verify_cert_proof(&key, &identity.name, proof).map(|()| names),
                Err(error) => Err(error),
            },
            Err(error) => Err(error),
        };
        match verified {
            Ok(names) => {
                self.login_issue(
                    &identity,
                    "auth.cert.login",
                    json!({ "commonNames": names.common_names }),
                )
                .await
            }
            Err(error) => {
                self.login_denied(&identity, "auth.cert.login", &error)
                    .await;
                Err(VaultError::Denied(format!("certificate rejected: {error}")).into())
            }
        }
    }

    /// AWS IAM login with a presigned `sts:GetCallerIdentity`.
    pub async fn aws_iam_login(
        &self,
        identity_name: &str,
        login: &AwsIamLogin,
    ) -> Result<IssuedToken> {
        let identity = self
            .login_identity(identity_name, "aws_iam", |auth| {
                matches!(auth, AuthMethod::AwsIam(_))
            })
            .await?;
        let AuthMethod::AwsIam(config) = &identity.auth else {
            return Err(VaultError::Invalid("identity does not use aws-iam login".into()).into());
        };
        let checked = async {
            let request = validate_sts_request(config, login)?;
            let arn = call_sts(&request).await?;
            if !arn_allowed(config, &arn) {
                bail!("caller `{arn}` is not allowed for this identity");
            }
            Ok(arn)
        }
        .await;
        match checked {
            Ok(arn) => {
                self.login_issue(&identity, "auth.aws_iam.login", json!({ "arn": arn }))
                    .await
            }
            Err(error) => {
                self.login_denied(&identity, "auth.aws_iam.login", &error)
                    .await;
                Err(VaultError::Denied(format!("AWS IAM login rejected: {error}")).into())
            }
        }
    }

    /// Kubernetes service-account login through `TokenReview`.
    pub async fn kubernetes_login(&self, identity_name: &str, jwt: &str) -> Result<IssuedToken> {
        let identity = self
            .login_identity(identity_name, "kubernetes", |auth| {
                matches!(auth, AuthMethod::Kubernetes(_))
            })
            .await?;
        let AuthMethod::Kubernetes(config) = &identity.auth else {
            return Err(
                VaultError::Invalid("identity does not use kubernetes login".into()).into(),
            );
        };
        let checked = async {
            let review = token_review(config, jwt).await?;
            check_token_review(config, &review)
        }
        .await;
        match checked {
            Ok((namespace, name)) => {
                self.login_issue(
                    &identity,
                    "auth.kubernetes.login",
                    json!({ "namespace": namespace, "serviceAccount": name }),
                )
                .await
            }
            Err(error) => {
                self.login_denied(&identity, "auth.kubernetes.login", &error)
                    .await;
                Err(VaultError::Denied(format!("Kubernetes login rejected: {error}")).into())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rcgen::{
        BasicConstraints, CertificateParams, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer,
        KeyPair, SanType,
    };

    struct TestPki {
        ca_pem: String,
        leaf_pem: String,
        leaf_key: KeyPair,
    }

    fn pki(cn: &str, dns: &str) -> TestPki {
        pki_with_eku(cn, dns, &[])
    }

    fn pki_with_eku(cn: &str, dns: &str, eku: &[ExtendedKeyUsagePurpose]) -> TestPki {
        let ca_key = KeyPair::generate().unwrap();
        let mut ca_params = CertificateParams::new(Vec::<String>::new()).unwrap();
        ca_params.is_ca = IsCa::Ca(BasicConstraints::Unconstrained);
        ca_params
            .distinguished_name
            .push(DnType::CommonName, "Test CA");
        let ca_cert = ca_params.self_signed(&ca_key).unwrap();
        let issuer = Issuer::new(ca_params, ca_key);
        let leaf_key = KeyPair::generate().unwrap();
        let mut leaf_params = CertificateParams::new(Vec::<String>::new()).unwrap();
        leaf_params.distinguished_name.push(DnType::CommonName, cn);
        leaf_params.subject_alt_names = vec![SanType::DnsName(dns.try_into().unwrap())];
        leaf_params.extended_key_usages = eku.to_vec();
        let leaf = leaf_params.signed_by(&leaf_key, &issuer).unwrap();
        TestPki {
            ca_pem: ca_cert.pem(),
            leaf_pem: leaf.pem(),
            leaf_key,
        }
    }

    fn proof(key: &KeyPair, sub: &str, jti: &str, lifetime: i64) -> String {
        let now = now_millis() / 1000;
        let encoding =
            jsonwebtoken::EncodingKey::from_ec_pem(key.serialize_pem().as_bytes()).unwrap();
        jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256),
            &json!({ "aud": CERT_LOGIN_AUDIENCE, "sub": sub, "iat": now, "exp": now + lifetime, "jti": jti }),
            &encoding,
        )
        .unwrap()
    }

    fn cert_config(ca_pem: &str) -> CertAuthConfig {
        CertAuthConfig {
            ca_pem: ca_pem.to_owned(),
            allowed_common_names: vec!["node-*".into()],
            allowed_dns_sans: vec![],
            allowed_uri_sans: vec![],
        }
    }

    #[test]
    fn cert_config_requires_a_ca_and_a_name_binding() {
        let test = pki("node-1", "node-1.mesh");
        assert!(cert_config(&test.ca_pem).validate().is_ok());
        let mut unbound = cert_config(&test.ca_pem);
        unbound.allowed_common_names.clear();
        assert!(unbound.validate().is_err());
        // A leaf certificate is not a CA.
        assert!(cert_config(&test.leaf_pem).validate().is_err());
        assert!(cert_config("not pem").validate().is_err());
    }

    #[test]
    fn client_certs_must_chain_to_the_ca_and_match_names() {
        let test = pki("node-1", "node-1.mesh");
        let (key, names) = verify_client_cert(&cert_config(&test.ca_pem), &test.leaf_pem).unwrap();
        assert!(key.starts_with("-----BEGIN PUBLIC KEY-----"));
        assert_eq!(names.common_names, vec!["node-1"]);
        assert_eq!(names.dns_sans, vec!["node-1.mesh"]);

        let other = pki("node-1", "node-1.mesh");
        assert!(verify_client_cert(&cert_config(&other.ca_pem), &test.leaf_pem).is_err());

        let mut by_dns = cert_config(&test.ca_pem);
        by_dns.allowed_common_names = vec!["web-*".into()];
        assert!(verify_client_cert(&by_dns, &test.leaf_pem).is_err());
        by_dns.allowed_dns_sans = vec!["*.mesh".into()];
        assert!(verify_client_cert(&by_dns, &test.leaf_pem).is_ok());
    }

    #[test]
    fn client_certs_need_the_client_auth_usage_when_eku_is_present() {
        let client = pki_with_eku(
            "node-1",
            "node-1.mesh",
            &[ExtendedKeyUsagePurpose::ClientAuth],
        );
        assert!(verify_client_cert(&cert_config(&client.ca_pem), &client.leaf_pem).is_ok());
        let server = pki_with_eku(
            "node-1",
            "node-1.mesh",
            &[ExtendedKeyUsagePurpose::ServerAuth],
        );
        let error = verify_client_cert(&cert_config(&server.ca_pem), &server.leaf_pem)
            .unwrap_err()
            .to_string();
        assert!(error.contains("client authentication"), "{error}");
    }

    async fn denied_logins(store: &PluginSecretStore, action: &str) -> i64 {
        let conn = store.conn.lock().await;
        conn.query_row(
            "SELECT COUNT(*) FROM vault_audit WHERE action = ?1 AND outcome = 'denied'",
            rusqlite::params![action],
            |row| row.get(0),
        )
        .unwrap()
    }

    #[tokio::test]
    async fn revoked_certificates_cannot_log_in() {
        let store = PluginSecretStore::in_memory().unwrap();
        let admin = AuditActor::new("user", Some("admin"));
        let test = pki("node-8", "node-8.mesh");
        store
            .machine_create(
                "mesh-node",
                AuthMethod::Cert(cert_config(&test.ca_pem)),
                vec!["mesh".into()],
                Some(600),
                &admin,
            )
            .await
            .unwrap();
        let (_, names) = verify_client_cert(&cert_config(&test.ca_pem), &test.leaf_pem).unwrap();
        {
            let conn = store.conn.lock().await;
            conn.execute(
                "INSERT INTO vault_pki_certs (serial, issuer, common_name, not_after, revoked_at, created_at)
                 VALUES (?1, 'default', 'node-8', ?2, ?3, ?3)",
                rusqlite::params![names.serial, now_millis() + 3_600_000, now_millis()],
            )
            .unwrap();
        }
        let jti = format!("revoked-{}", now_millis());
        let error = store
            .cert_login(
                "mesh-node",
                &test.leaf_pem,
                &proof(&test.leaf_key, "mesh-node", &jti, 60),
            )
            .await
            .unwrap_err()
            .to_string();
        assert!(error.contains("revoked"), "{error}");
        assert_eq!(denied_logins(&store, "auth.cert.login").await, 1);
    }

    #[tokio::test]
    async fn unknown_disabled_and_mismatched_identities_are_audited() {
        let store = PluginSecretStore::in_memory().unwrap();
        let admin = AuditActor::new("user", Some("admin"));
        let test = pki("node-9", "node-9.mesh");
        store
            .machine_create(
                "mesh-node",
                AuthMethod::Cert(cert_config(&test.ca_pem)),
                vec!["mesh".into()],
                Some(600),
                &admin,
            )
            .await
            .unwrap();
        assert!(store
            .cert_login("nobody", &test.leaf_pem, "x")
            .await
            .is_err());
        assert_eq!(denied_logins(&store, "auth.cert.login").await, 1);
        assert!(store.kubernetes_login("mesh-node", "jwt").await.is_err());
        assert_eq!(denied_logins(&store, "auth.kubernetes.login").await, 1);
    }

    #[test]
    fn proofs_bind_the_identity_lifetime_and_are_single_use() {
        let test = pki("node-1", "node-1.mesh");
        let (key, _) = verify_client_cert(&cert_config(&test.ca_pem), &test.leaf_pem).unwrap();
        let jti = format!("j-{}", now_millis());
        let good = proof(&test.leaf_key, "mesh-node", &jti, 60);
        assert!(verify_cert_proof(&key, "other-identity", &good).is_err());
        assert!(verify_cert_proof(&key, "mesh-node", &good).is_ok());
        assert!(
            verify_cert_proof(&key, "mesh-node", &good).is_err(),
            "replay"
        );
        let long = proof(&test.leaf_key, "mesh-node", &format!("{jti}-long"), 3600);
        assert!(verify_cert_proof(&key, "mesh-node", &long).is_err());
        let stranger = KeyPair::generate().unwrap();
        let forged = proof(&stranger, "mesh-node", &format!("{jti}-forged"), 60);
        assert!(verify_cert_proof(&key, "mesh-node", &forged).is_err());
    }

    /// The replay cache keeps a proof id past its `exp` for longer than the
    /// 30 s validation leeway, so a proof that just expired (still accepted
    /// inside the leeway) cannot be replayed after a later login prunes.
    #[test]
    fn a_proof_inside_the_expiry_leeway_is_still_single_use() {
        let test = pki("node-2", "node-2.mesh");
        let (key, _) = verify_client_cert(&cert_config(&test.ca_pem), &test.leaf_pem).unwrap();
        let now = now_millis() / 1000;
        let encoding =
            jsonwebtoken::EncodingKey::from_ec_pem(test.leaf_key.serialize_pem().as_bytes())
                .unwrap();
        let jti = format!("leeway-{}", now_millis());
        let expired = jsonwebtoken::encode(
            &jsonwebtoken::Header::new(jsonwebtoken::Algorithm::ES256),
            &json!({ "aud": CERT_LOGIN_AUDIENCE, "sub": "mesh-node", "iat": now - 40, "exp": now - 10, "jti": jti }),
            &encoding,
        )
        .unwrap();
        assert!(verify_cert_proof(&key, "mesh-node", &expired).is_ok());
        // Another login prunes the cache; the expired-but-in-leeway id stays.
        let other = proof(&test.leaf_key, "mesh-node", &format!("{jti}-other"), 60);
        assert!(verify_cert_proof(&key, "mesh-node", &other).is_ok());
        assert!(
            verify_cert_proof(&key, "mesh-node", &expired).is_err(),
            "replay inside the leeway"
        );
    }

    #[tokio::test]
    async fn cert_identities_log_in_end_to_end() {
        let store = PluginSecretStore::in_memory().unwrap();
        let admin = AuditActor::new("user", Some("admin"));
        let test = pki("node-7", "node-7.mesh");
        store
            .machine_create(
                "mesh-node",
                AuthMethod::Cert(cert_config(&test.ca_pem)),
                vec!["mesh".into()],
                Some(600),
                &admin,
            )
            .await
            .unwrap();
        let jti = format!("e2e-{}", now_millis());
        let token = store
            .cert_login(
                "mesh-node",
                &test.leaf_pem,
                &proof(&test.leaf_key, "mesh-node", &jti, 60),
            )
            .await
            .unwrap();
        assert!(token.token.starts_with("rvt_"));
        let principal = store.token_lookup(&token.token).await.unwrap().unwrap();
        assert_eq!(principal.identity_name, "mesh-node");
        assert!(store
            .cert_login("mesh-node", &test.leaf_pem, "not-a-jwt")
            .await
            .is_err());
    }

    #[tokio::test]
    async fn cert_logins_honor_the_identity_bound_cidrs() {
        use crate::vault::tokens::{with_request_context, RequestContext, TokenConfig};
        let store = PluginSecretStore::in_memory().unwrap();
        let admin = AuditActor::new("user", Some("admin"));
        let test = pki("node-5", "node-5.mesh");
        store
            .machine_create(
                "mesh-node",
                AuthMethod::Cert(cert_config(&test.ca_pem)),
                vec!["mesh".into()],
                Some(600),
                &admin,
            )
            .await
            .unwrap();
        store
            .machine_set_token_config(
                "mesh-node",
                TokenConfig {
                    bound_cidrs: vec!["10.0.0.0/8".into()],
                    ..TokenConfig::default()
                },
                &admin,
            )
            .await
            .unwrap();
        let jti = format!("cidr-{}", now_millis());
        let outside = RequestContext::new(Some("192.0.2.1".parse().unwrap()));
        let refused = with_request_context(
            outside,
            store.cert_login(
                "mesh-node",
                &test.leaf_pem,
                &proof(&test.leaf_key, "mesh-node", &format!("{jti}-out"), 60),
            ),
        )
        .await
        .unwrap_err();
        assert_eq!(
            refused.downcast_ref::<VaultError>().unwrap().code(),
            "vault_denied"
        );
        assert_eq!(denied_logins(&store, "auth.cert.login").await, 1);
        let inside = RequestContext::new(Some("10.1.2.3".parse().unwrap()));
        let token = with_request_context(
            inside,
            store.cert_login(
                "mesh-node",
                &test.leaf_pem,
                &proof(&test.leaf_key, "mesh-node", &format!("{jti}-in"), 60),
            ),
        )
        .await
        .unwrap();
        assert!(token.token.starts_with("rvt_"));
    }

    fn b64(text: &str) -> String {
        base64::engine::general_purpose::STANDARD.encode(text)
    }

    fn aws_config(server_id: Option<&str>) -> AwsIamAuthConfig {
        AwsIamAuthConfig {
            bound_iam_principal_arns: vec!["arn:aws:iam::123456789012:role/ci-*".into()],
            server_id_header_value: server_id.map(str::to_owned),
            sts_endpoint: None,
        }
    }

    fn sts_login(url: &str, body: &str, headers: Value) -> AwsIamLogin {
        AwsIamLogin {
            iam_http_request_method: "POST".into(),
            iam_request_url: b64(url),
            iam_request_body: b64(body),
            iam_request_headers: b64(&headers.to_string()),
        }
    }

    const SIGNED: &str = "AWS4-HMAC-SHA256 Credential=AKIA/20260101/us-east-1/sts/aws4_request, \
                          SignedHeaders=content-type;host;x-amz-date;x-ryu-server-id, Signature=abc";

    #[test]
    fn only_signed_get_caller_identity_reaches_sts() {
        let config = aws_config(Some("vault.example.com"));
        let headers = json!({
            "Authorization": SIGNED,
            "X-Ryu-Server-ID": "vault.example.com",
            "X-Amz-Date": "20260101T000000Z",
            "Host": "sts.amazonaws.com",
        });
        let body = "Action=GetCallerIdentity&Version=2011-06-15";
        let ok = validate_sts_request(&config, &sts_login(DEFAULT_STS_URL, body, headers.clone()))
            .unwrap();
        assert_eq!(ok.url, DEFAULT_STS_URL);
        assert!(ok.headers.iter().all(|(name, _)| name != "host"));

        for (url, body) in [
            ("https://evil.example.com/", body),
            ("http://sts.amazonaws.com/", body),
            ("https://sts.amazonaws.com/?Action=AssumeRole", body),
            (DEFAULT_STS_URL, "Action=AssumeRole&Version=2011-06-15"),
            (
                DEFAULT_STS_URL,
                "Action=GetCallerIdentity&Version=2011-06-15&X=1",
            ),
        ] {
            assert!(
                validate_sts_request(&config, &sts_login(url, body, headers.clone())).is_err(),
                "{url} {body}"
            );
        }
        let wrong_server = json!({ "Authorization": SIGNED, "X-Ryu-Server-ID": "other" });
        assert!(
            validate_sts_request(&config, &sts_login(DEFAULT_STS_URL, body, wrong_server)).is_err()
        );
        let unsigned_server = json!({
            "Authorization": "AWS4-HMAC-SHA256 Credential=x, SignedHeaders=host;x-amz-date, Signature=abc",
            "X-Ryu-Server-ID": "vault.example.com",
        });
        assert!(
            validate_sts_request(&config, &sts_login(DEFAULT_STS_URL, body, unsigned_server))
                .is_err()
        );
        let unsigned = json!({ "X-Ryu-Server-ID": "vault.example.com" });
        assert!(
            validate_sts_request(&config, &sts_login(DEFAULT_STS_URL, body, unsigned)).is_err()
        );
        // A legacy row without a server id fails closed.
        assert!(validate_sts_request(
            &aws_config(None),
            &sts_login(DEFAULT_STS_URL, body, headers)
        )
        .is_err());
    }

    #[test]
    fn aws_login_accepts_camel_and_snake_case_fields() {
        for body in [
            json!({ "iamRequestUrl": "dQ==", "iamRequestBody": "Yg==", "iamRequestHeaders": "e30=" }),
            json!({ "iam_http_request_method": "POST", "iam_request_url": "dQ==",
                    "iam_request_body": "Yg==", "iam_request_headers": "e30=" }),
        ] {
            let login: AwsIamLogin = serde_json::from_value(body).unwrap();
            assert_eq!(login.iam_request_url, "dQ==");
            assert_eq!(login.iam_http_request_method, "POST");
        }
    }

    #[test]
    fn sts_hosts_and_arns_are_matched_strictly() {
        assert!(is_sts_host("sts.amazonaws.com"));
        assert!(is_sts_host("sts.eu-west-1.amazonaws.com"));
        assert!(is_sts_host("sts.cn-north-1.amazonaws.com.cn"));
        assert!(!is_sts_host("sts.amazonaws.com.evil.io"));
        assert!(!is_sts_host("evil.sts.amazonaws.com"));
        assert!(!is_sts_host("sts.evil.com"));
        assert!(
            aws_config(None).validate().is_err(),
            "server id is required"
        );
        assert!(aws_config(Some(" ")).validate().is_err());
        let mut config = aws_config(Some("vault.example.com"));
        assert!(config.validate().is_ok());
        config.sts_endpoint = Some("https://sts.evil.com/".into());
        assert!(config.validate().is_err());

        let config = aws_config(None);
        assert!(arn_allowed(
            &config,
            "arn:aws:sts::123456789012:assumed-role/ci-deploy/i-0abc"
        ));
        assert!(arn_allowed(
            &config,
            "arn:aws:iam::123456789012:role/ci-build"
        ));
        assert!(!arn_allowed(
            &config,
            "arn:aws:sts::999999999999:assumed-role/ci-deploy/i-0abc"
        ));
        assert!(!arn_allowed(&config, "arn:aws:iam::123456789012:user/ci-x"));
        assert_eq!(
            xml_text("<GetCallerIdentityResult><Arn>arn:aws:iam::1:user/a</Arn></GetCallerIdentityResult>", "Arn"),
            Some("arn:aws:iam::1:user/a")
        );
    }

    fn k8s_config() -> KubernetesAuthConfig {
        KubernetesAuthConfig {
            host: "https://10.0.0.1:6443".into(),
            ca_pem: None,
            reviewer_jwt_env: None,
            bound_service_account_names: vec!["deployer".into()],
            bound_service_account_namespaces: vec!["prod-*".into()],
            audiences: vec![],
        }
    }

    #[test]
    fn token_reviews_bind_namespace_and_service_account() {
        let config = k8s_config();
        assert!(config.validate().is_ok());
        let review = |authenticated: bool, username: &str| json!({ "status": { "authenticated": authenticated, "user": { "username": username } } });
        assert_eq!(
            check_token_review(
                &config,
                &review(true, "system:serviceaccount:prod-eu:deployer")
            )
            .unwrap(),
            ("prod-eu".to_owned(), "deployer".to_owned())
        );
        assert!(check_token_review(
            &config,
            &review(false, "system:serviceaccount:prod-eu:deployer")
        )
        .is_err());
        assert!(
            check_token_review(&config, &review(true, "system:serviceaccount:dev:deployer"))
                .is_err()
        );
        assert!(check_token_review(
            &config,
            &review(true, "system:serviceaccount:prod-eu:other")
        )
        .is_err());
        assert!(check_token_review(&config, &review(true, "alice@example.com")).is_err());

        let mut with_aud = k8s_config();
        with_aud.audiences = vec!["ryu".into()];
        let granted = json!({ "status": { "authenticated": true, "audiences": ["ryu"],
            "user": { "username": "system:serviceaccount:prod-eu:deployer" } } });
        assert!(check_token_review(&with_aud, &granted).is_ok());
        assert!(check_token_review(
            &with_aud,
            &review(true, "system:serviceaccount:prod-eu:deployer")
        )
        .is_err());

        let mut bad = k8s_config();
        bad.host = "http://10.0.0.1".into();
        assert!(bad.validate().is_err());
        let mut unbound = k8s_config();
        unbound.bound_service_account_namespaces.clear();
        assert!(unbound.validate().is_err());
    }

    #[tokio::test]
    async fn reviewer_env_cannot_name_other_secrets() {
        for env in [
            "RYU_MASTER_KEY",
            "RYU_TOKEN",
            "RYU_VAULT_SEAL_KEY",
            "RYU_VAULT_SEAL_TRANSIT_TOKEN",
            "OPENAI_API_KEY",
            "ANTHROPIC_API_KEY",
            "RYU_VAULT_K8S_REVIEWER_",
            "RYU_VAULT_K8S_REVIEWER_lower",
            "",
        ] {
            let mut config = k8s_config();
            config.reviewer_jwt_env = Some(env.to_owned());
            assert!(config.validate().is_err(), "{env} must be rejected");
            // A stored row that bypassed validation is rejected at use,
            // before any request is sent.
            let error = token_review(&config, "client-jwt").await.unwrap_err();
            assert!(
                error.to_string().contains("reviewerJwtEnv"),
                "{env}: {error}"
            );
        }
        let mut allowed = k8s_config();
        allowed.reviewer_jwt_env = Some("RYU_VAULT_K8S_REVIEWER_AUTH_TEST_PROD".into());
        // A variable name no other test reads.
        std::env::set_var(
            "RYU_VAULT_K8S_HOST_AUTH_TEST_PROD",
            "https://10.0.0.1:6443/",
        );
        assert!(allowed.validate().is_ok());
    }

    #[tokio::test]
    async fn reviewer_tokens_go_only_to_the_pinned_api_server() {
        let mut config = k8s_config();
        config.reviewer_jwt_env = Some("RYU_VAULT_K8S_REVIEWER_AUTH_TEST_PIN".into());
        std::env::set_var("RYU_VAULT_K8S_REVIEWER_AUTH_TEST_PIN", "reviewer-secret");
        // Without an operator pin the reviewer token is never sent.
        let error = config.validate().unwrap_err();
        assert!(
            error
                .to_string()
                .contains("RYU_VAULT_K8S_HOST_AUTH_TEST_PIN"),
            "{error}"
        );
        let error = token_review(&config, "client-jwt").await.unwrap_err();
        assert!(
            error
                .to_string()
                .contains("RYU_VAULT_K8S_HOST_AUTH_TEST_PIN"),
            "{error}"
        );
        std::env::set_var("RYU_VAULT_K8S_HOST_AUTH_TEST_PIN", "https://10.0.0.1:6443");
        assert!(config.validate().is_ok());
        // A host the identity configurator chose is refused before any
        // request, whatever CA it supplies.
        for host in [
            "https://attacker.example",
            "https://10.0.0.1:6444",
            "https://10.0.0.1:6443/proxy",
            "https://10.0.0.1:6443/?x=",
            "https://user:pw@10.0.0.1:6443",
        ] {
            let mut redirected = config.clone();
            redirected.host = host.to_owned();
            assert!(redirected.validate().is_err(), "{host}");
            assert!(
                token_review(&redirected, "client-jwt").await.is_err(),
                "{host}"
            );
        }
        // The client's own JWT as reviewer needs no pin.
        assert!(k8s_config().validate().is_ok());
    }
}
