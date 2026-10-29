//! Policy-bearing workspace requests over the generic OpenSandbox provider.
//! Credentials travel only to the authenticated broker over attested transport.
//! Workloads receive placeholders. Runtime readbacks precede execution.
use crate::win_process::NoWindow;
use crate::{ExecOutput, WorkspaceId};
use anyhow::{anyhow, ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::OsString,
    io::Write,
    time::Duration,
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::timeout,
};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum EgressPolicy {
    Denied,
    Unrestricted,
    AllowedHosts(Vec<String>),
}
#[derive(Clone)]
pub struct ProxyCredential {
    pub name: String,
    pub value: String,
    pub placeholder: String,
    pub hosts: Vec<String>,
}
impl std::fmt::Debug for ProxyCredential {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ProxyCredential")
            .field("name", &self.name)
            .field("hosts", &self.hosts)
            .finish_non_exhaustive()
    }
}
#[derive(Clone, Debug)]
pub struct GovernedWorkspaceSpec {
    pub egress: EgressPolicy,
    pub credentials: Vec<ProxyCredential>,
}
impl GovernedWorkspaceSpec {
    pub fn network_policy(&self) -> Value {
        match &self.egress {
            EgressPolicy::Unrestricted => json!({"defaultAction":"allow","egress":[]}),
            EgressPolicy::Denied => json!({"defaultAction":"deny","egress":[]}),
            EgressPolicy::AllowedHosts(hosts) => {
                json!({"defaultAction":"deny","egress":hosts.iter().map(|host|json!({"action":"allow","target":host})).collect::<Vec<_>>()})
            }
        }
    }
    pub fn credential_vault(&self) -> Result<Value> {
        ensure!(self.credentials.len() <= 100, "Too many proxy credentials");
        let mut names = BTreeSet::new();
        let mut hosts: BTreeMap<String, Vec<Value>> = BTreeMap::new();
        for credential in &self.credentials {
            ensure!(
                !credential.name.is_empty()
                    && credential.name.len() <= 128
                    && names.insert(&credential.name),
                "Invalid or duplicate credential name"
            );
            ensure!(
                !credential.value.is_empty()
                    && credential.value.len() <= 65536
                    && !credential.placeholder.is_empty()
                    && credential.hosts.len() <= 100
                    && !credential.hosts.is_empty(),
                "Invalid proxy credential"
            );
            for host in &credential.hosts {
                ensure!(valid_host(host), "Invalid credential host");
                hosts.entry(host.clone()).or_default().push(json!({"credential":credential.name,"placeholder":credential.placeholder,"in":["header","query","body","path"]}));
            }
        }
        let distinct: Vec<_> = hosts.keys().collect();
        for (index, a) in distinct.iter().enumerate() {
            for b in distinct.iter().skip(index + 1) {
                ensure!(
                    !host_patterns_overlap(a, b),
                    "Overlapping credential host patterns must use one exact domain scope"
                );
            }
        }
        if let EgressPolicy::AllowedHosts(allowed) = &self.egress {
            ensure!(
                allowed.len() <= 200 && allowed.iter().all(|h| valid_host(h)),
                "Invalid egress allowlist"
            );
        }
        Ok(
            json!({"credentials":self.credentials.iter().map(|c|json!({"name":c.name,"source":{"type":"inline","value":c.value}})).collect::<Vec<_>>(),"bindings":hosts.into_iter().enumerate().map(|(index,(host,substitutions))| json!({"name":format!("ryu-host-{index}"),"match":{"schemes":["https"],"hosts":[host],"methods":["GET","HEAD","POST","PUT","PATCH","DELETE","OPTIONS"],"paths":["/*"]},"auth":{"type":"passthrough","substitutions":substitutions}})).collect::<Vec<_>>()}),
        )
    }
}
fn host_patterns_overlap(a: &str, b: &str) -> bool {
    fn matches(pattern: &str, host: &str) -> bool {
        pattern.strip_prefix("*.").is_some_and(|suffix| {
            host.ends_with(&format!(".{suffix}"))
                || host
                    .strip_prefix("*.")
                    .is_some_and(|other| suffix == other || suffix.ends_with(&format!(".{other}")))
        })
    }
    a == b || matches(a, b) || matches(b, a)
}
pub fn valid_host(host: &str) -> bool {
    let value = host.strip_prefix("*.").unwrap_or(host);
    if value.is_empty() || value.len() > 253 || value.contains('*') {
        return false;
    }
    if value.bytes().all(|c| c.is_ascii_digit() || c == b'.') {
        return !host.starts_with("*.") && value.parse::<std::net::Ipv4Addr>().is_ok();
    }
    value.split('.').all(|label| {
        !label.is_empty()
            && label.len() <= 63
            && !label.starts_with('-')
            && !label.ends_with('-')
            && label
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'-')
    })
}
pub struct GovernedOpenSandbox {
    binary: OsString,
    image: String,
    lifetime: String,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GovernedWorkspace {
    id: WorkspaceId,
    connection: Vec<OsString>,
}
impl GovernedWorkspace {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.id.0.is_empty()
                && self.id.0.len() <= 200
                && self
                    .id
                    .0
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte)),
            "Invalid governed workspace identity"
        );
        ensure!(
            self.connection.len() == 5
                && self.connection[0] == "--domain"
                && self.connection[2] == "--protocol"
                && self.connection[4] == "--use-server-proxy",
            "Invalid governed connection metadata"
        );
        let domain = self.connection[1]
            .to_str()
            .ok_or_else(|| anyhow!("Invalid governed connection address"))?;
        let protocol = self.connection[3]
            .to_str()
            .ok_or_else(|| anyhow!("Invalid governed connection protocol"))?;
        let (expected, _) = attested_connection(&json!({"domain":domain,"protocol":protocol}))?;
        ensure!(
            expected == self.connection,
            "Governed connection metadata changed"
        );
        Ok(())
    }
}
impl GovernedOpenSandbox {
    pub fn new(binary: OsString, image: String, lifetime: String) -> Self {
        Self {
            binary,
            image,
            lifetime,
        }
    }
    async fn call(
        &self,
        args: &[OsString],
        stdin: Option<Vec<u8>>,
        seconds: u64,
    ) -> Result<ExecOutput> {
        let mut command = Command::new(&self.binary);
        command
            .args(args)
            .no_window()
            .kill_on_drop(true)
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if stdin.is_some() {
            command.stdin(std::process::Stdio::piped());
        } else {
            command.stdin(std::process::Stdio::null());
        }
        let run = async {
            let mut child = command
                .spawn()
                .map_err(|_| anyhow!("OpenSandbox CLI is unavailable"))?;
            let stdout = tokio::spawn(capture(
                child
                    .stdout
                    .take()
                    .ok_or_else(|| anyhow!("OpenSandbox stdout unavailable"))?,
            ));
            let stderr = tokio::spawn(capture(
                child
                    .stderr
                    .take()
                    .ok_or_else(|| anyhow!("OpenSandbox stderr unavailable"))?,
            ));
            if let Some(bytes) = stdin {
                if let Some(mut writer) = child.stdin.take() {
                    writer.write_all(&bytes).await?;
                }
            }
            let status = child.wait().await?;
            Ok::<_, anyhow::Error>(ExecOutput {
                exit_code: status.code().unwrap_or(-1),
                stdout: stdout.await??,
                stderr: stderr.await??,
            })
        };
        timeout(Duration::from_secs(seconds), run)
            .await
            .map_err(|_| anyhow!("OpenSandbox CLI operation timed out"))?
    }
    async fn checked(&self, args: &[OsString], stdin: Option<Vec<u8>>) -> Result<Value> {
        let output = self.call(args, stdin, 30).await?;
        ensure!(output.exit_code == 0, "OpenSandbox operation failed");
        ensure!(
            output.stdout.len() <= 1_048_576,
            "OpenSandbox response exceeded limit"
        );
        serde_json::from_slice(&output.stdout)
            .map_err(|_| anyhow!("OpenSandbox returned invalid JSON"))
    }
    pub async fn create(&self, spec: &GovernedWorkspaceSpec) -> Result<GovernedWorkspace> {
        let vault = spec.credential_vault()?;
        let help = self
            .call(&args(&["sandbox", "create", "--help"]), None, 10)
            .await?;
        let help = String::from_utf8_lossy(&help.stdout);
        ensure!(
            help.contains("--network-policy-file") && help.contains("--credential-proxy"),
            "OpenSandbox CLI lacks governed-workspace support"
        );
        let config = self
            .checked(&args(&["config", "show", "-o", "json"]), None)
            .await?;
        let (connection, origin) = attested_connection(&config)?;
        let mut policy = tempfile::NamedTempFile::new()?;
        policy.write_all(&serde_json::to_vec(&spec.network_policy())?)?;
        policy.flush()?;
        let mut create_args = connection.clone();
        create_args.extend(vec![
            "sandbox".into(),
            "create".into(),
            "--image".into(),
            self.image.clone().into(),
            "--timeout".into(),
            self.lifetime.clone().into(),
            "--network-policy-file".into(),
            policy.path().as_os_str().into(),
            "--credential-proxy".into(),
            "-o".into(),
            "json".into(),
        ]);
        let create = self.checked(&create_args, None).await?;
        let id = create
            .get("id")
            .or_else(|| create.get("sandbox_id"))
            .or_else(|| create.get("sandboxId"))
            .and_then(Value::as_str)
            .filter(|id| {
                !id.is_empty()
                    && id.len() <= 200
                    && id
                        .bytes()
                        .all(|c| c.is_ascii_alphanumeric() || b"-_.".contains(&c))
            })
            .ok_or_else(|| anyhow!("OpenSandbox returned invalid sandbox id"))?
            .to_owned();
        let workspace = GovernedWorkspace {
            id: WorkspaceId(id.clone()),
            connection,
        };
        let prepare = async {
            let mut prefix = workspace.connection.clone();
            prefix.extend(args(&[
                "sandbox", "endpoint", &id, "--port", "18080", "-o", "json",
            ]));
            let endpoint = self.checked(&prefix, None).await?;
            let broker = BrokerEndpoint::parse(&endpoint, &origin, &config)?;
            let policy = broker.request(reqwest::Method::GET, "policy", None).await?;
            verify_policy(&policy, &spec.network_policy())?;
            if !spec.credentials.is_empty() {
                let acknowledged = broker
                    .request(reqwest::Method::POST, "credential-vault", Some(&vault))
                    .await?;
                verify_vault(&acknowledged, &vault)?;
                let readback = broker
                    .request(reqwest::Method::GET, "credential-vault", None)
                    .await?;
                verify_vault(&readback, &vault)?;
            }
            Ok::<_, anyhow::Error>(())
        }
        .await;
        if let Err(error) = prepare {
            let _ = self.destroy(&workspace).await;
            return Err(error);
        }
        Ok(workspace)
    }
    pub async fn execute_script(
        &self,
        workspace: &GovernedWorkspace,
        script: &str,
        seconds: u64,
    ) -> Result<ExecOutput> {
        workspace.validate()?;
        ensure!(
            script.len() <= 1_048_576 && (1..=1800).contains(&seconds),
            "Governed execution input exceeds limits"
        );
        // Ordinary environment variables are task-visible; temporary upload is
        // permissioned. Network credentials never occur in this script.
        let mut source = tempfile::NamedTempFile::new()?;
        source.write_all(script.as_bytes())?;
        source.flush()?;
        let remote = "/tmp/ryu-cloud-setup.sh";
        let mut upload = workspace.connection.clone();
        upload.extend(vec![
            "file".into(),
            "upload".into(),
            workspace.id.0.clone().into(),
            source.path().as_os_str().into(),
            remote.into(),
            "-o".into(),
            "json".into(),
        ]);
        self.checked(&upload, None).await?;
        let mut command = workspace.connection.clone();
        command.extend(args(&[
            "command",
            "run",
            &workspace.id.0,
            "-o",
            "raw",
            "--argv",
            "--",
            "sh",
            remote,
        ]));
        self.call(&command, None, seconds).await
    }
    pub async fn destroy(&self, workspace: &GovernedWorkspace) -> Result<()> {
        workspace.validate()?;
        let mut command = workspace.connection.clone();
        command.extend(args(&["sandbox", "kill", &workspace.id.0, "-o", "json"]));
        let output = self.call(&command, None, 30).await?;
        ensure!(output.exit_code == 0, "OpenSandbox cleanup failed");
        Ok(())
    }
}
async fn capture<R: tokio::io::AsyncRead + Unpin>(mut reader: R) -> Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let remaining = 1_048_577usize.saturating_sub(result.len());
        result.extend_from_slice(&buffer[..count.min(remaining)]);
    }
    Ok(result)
}
fn args(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}
fn attested_connection(config: &Value) -> Result<(Vec<OsString>, reqwest::Url)> {
    let protocol = config["protocol"]
        .as_str()
        .ok_or_else(|| anyhow!("OpenSandbox transport protocol is unverified"))?;
    let domain = config["domain"]
        .as_str()
        .filter(|domain| !domain.is_empty() && domain.len() <= 512)
        .ok_or_else(|| anyhow!("OpenSandbox transport domain is unverified"))?;
    ensure!(
        matches!(protocol, "https" | "http"),
        "OpenSandbox transport protocol is unsupported"
    );
    let origin = reqwest::Url::parse(&format!("{protocol}://{domain}"))
        .map_err(|_| anyhow!("OpenSandbox transport address is invalid"))?;
    ensure!(
        origin.username().is_empty()
            && origin.password().is_none()
            && origin.query().is_none()
            && origin.fragment().is_none()
            && origin.path() == "/",
        "OpenSandbox transport address must be an origin"
    );
    ensure!(
        secure_transport(&origin),
        "OpenSandbox control plane requires HTTPS or literal loopback HTTP"
    );
    Ok((
        vec![
            "--domain".into(),
            domain.into(),
            "--protocol".into(),
            protocol.into(),
            "--use-server-proxy".into(),
        ],
        origin,
    ))
}
fn secure_transport(url: &reqwest::Url) -> bool {
    url.scheme() == "https"
        || url.scheme() == "http"
            && url
                .host_str()
                .and_then(|host| {
                    host.trim_matches(['[', ']'])
                        .parse::<std::net::IpAddr>()
                        .ok()
                })
                .is_some_and(|ip| ip.is_loopback())
}
struct BrokerEndpoint {
    base: reqwest::Url,
    headers: reqwest::header::HeaderMap,
    client: reqwest::Client,
}
impl BrokerEndpoint {
    fn parse(endpoint: &Value, origin: &reqwest::Url, config: &Value) -> Result<Self> {
        let address = endpoint["endpoint"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 2048)
            .ok_or_else(|| anyhow!("OpenSandbox broker endpoint is unverified"))?;
        let mut base = reqwest::Url::parse(
            if address.contains("://") {
                address.to_owned()
            } else {
                format!("{}://{address}", origin.scheme())
            }
            .as_str(),
        )
        .map_err(|_| anyhow!("OpenSandbox broker endpoint is invalid"))?;
        ensure!(
            secure_transport(&base)
                && base.origin() == origin.origin()
                && base.username().is_empty()
                && base.password().is_none()
                && base.query().is_none()
                && base.fragment().is_none(),
            "OpenSandbox broker must use the attested secure server proxy origin"
        );
        let path = base.path().trim_end_matches('/').to_owned();
        base.set_path(&path);
        let mut headers = reqwest::header::HeaderMap::new();
        if let Some(values) = endpoint.get("headers").and_then(Value::as_object) {
            ensure!(
                values.len() <= 32,
                "OpenSandbox endpoint has too many headers"
            );
            for (name, value) in values {
                let name = reqwest::header::HeaderName::from_bytes(name.as_bytes())
                    .map_err(|_| anyhow!("OpenSandbox endpoint header is invalid"))?;
                ensure!(
                    !matches!(
                        name.as_str(),
                        "host"
                            | "content-length"
                            | "transfer-encoding"
                            | "connection"
                            | "forwarded"
                            | "x-forwarded-host"
                            | "proxy-authorization"
                            | "upgrade"
                    ),
                    "OpenSandbox endpoint attempted to override transport routing"
                );
                let value = value
                    .as_str()
                    .filter(|value| value.len() <= 16384)
                    .ok_or_else(|| anyhow!("OpenSandbox endpoint header value is invalid"))?;
                headers.insert(
                    name,
                    reqwest::header::HeaderValue::from_str(value)
                        .map_err(|_| anyhow!("OpenSandbox endpoint header value is invalid"))?,
                );
            }
        }
        // The SDK adds the configured lifecycle API key when using its server
        // proxy. Use that same trusted configuration boundary, never a UI value.
        if !headers.contains_key("open-sandbox-api-key") {
            if let Some(key) = provider_api_key(config)? {
                headers.insert(
                    "open-sandbox-api-key",
                    reqwest::header::HeaderValue::from_str(&key)
                        .map_err(|_| anyhow!("OpenSandbox provider authentication is invalid"))?,
                );
            }
        }
        ensure!(
            headers.iter().any(|(name, value)| matches!(
                name.as_str(),
                "authorization"
                    | "opensandbox-egress-auth"
                    | "open-sandbox-api-key"
                    | "open-sandbox-access-token"
            ) && !value.as_bytes().is_empty()),
            "OpenSandbox broker authentication is unverified"
        );
        let client = reqwest::Client::builder()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(30))
            .build()?;
        Ok(Self {
            base,
            headers,
            client,
        })
    }
    async fn request(
        &self,
        method: reqwest::Method,
        path: &str,
        payload: Option<&Value>,
    ) -> Result<Value> {
        let mut url = self.base.clone();
        url.set_path(&format!(
            "{}/{path}",
            self.base.path().trim_end_matches('/')
        ));
        let mut request = self
            .client
            .request(method, url)
            .headers(self.headers.clone());
        if let Some(payload) = payload {
            request = request.json(payload);
        }
        let mut response = request
            .send()
            .await
            .map_err(|_| anyhow!("OpenSandbox broker transport failed"))?;
        ensure!(
            response.status().is_success(),
            "OpenSandbox broker request failed"
        );
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| anyhow!("OpenSandbox broker response failed"))?
        {
            ensure!(
                bytes.len() + chunk.len() <= 1_048_576,
                "OpenSandbox broker response exceeded limit"
            );
            bytes.extend_from_slice(&chunk);
        }
        serde_json::from_slice(&bytes)
            .map_err(|_| anyhow!("OpenSandbox broker returned invalid JSON"))
    }
}
fn provider_api_key(config: &Value) -> Result<Option<String>> {
    if !config
        .get("api_key")
        .and_then(Value::as_str)
        .is_some_and(|value| !value.is_empty())
    {
        return Ok(None);
    }
    if let Ok(key) = std::env::var("OPEN_SANDBOX_API_KEY") {
        if !key.is_empty() {
            return Ok(Some(key));
        }
    }
    let Some(path) = config.get("config_path").and_then(Value::as_str) else {
        return Ok(None);
    };
    let metadata = match std::fs::metadata(path) {
        Ok(value) => value,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err(anyhow!("OpenSandbox provider configuration is unavailable")),
    };
    ensure!(
        metadata.is_file() && metadata.len() <= 65536,
        "OpenSandbox provider configuration exceeds limits"
    );
    let text = std::fs::read_to_string(path)
        .map_err(|_| anyhow!("OpenSandbox provider configuration is unavailable"))?;
    let file: toml::Value = toml::from_str(&text)
        .map_err(|_| anyhow!("OpenSandbox provider configuration is invalid"))?;
    Ok(file
        .get("connection")
        .and_then(|connection| connection.get("api_key"))
        .and_then(toml::Value::as_str)
        .filter(|key| !key.is_empty())
        .map(str::to_owned))
}
pub(crate) fn verify_policy(readback: &Value, expected: &Value) -> Result<()> {
    ensure!(
        readback["status"] == "ok"
            && readback
                .get("enforcementMode")
                .or_else(|| readback.get("enforcement_mode"))
                .and_then(Value::as_str)
                == Some("dns+nft"),
        "OpenSandbox did not attest ready packet-level egress enforcement"
    );
    let policy = readback
        .get("policy")
        .or_else(|| readback.get("network_policy"))
        .or_else(|| readback.get("networkPolicy"))
        .unwrap_or(readback);
    let action = policy
        .get("defaultAction")
        .or_else(|| policy.get("default_action"));
    ensure!(
        action == expected.get("defaultAction"),
        "OpenSandbox egress policy readback mismatch"
    );
    let actual: BTreeSet<_> = policy
        .get("egress")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("OpenSandbox policy rules missing"))?
        .iter()
        .map(|r| {
            (
                r["action"].as_str().unwrap_or(""),
                r["target"].as_str().unwrap_or(""),
            )
        })
        .collect();
    let expected: BTreeSet<_> = expected["egress"]
        .as_array()
        .unwrap()
        .iter()
        .map(|r| (r["action"].as_str().unwrap(), r["target"].as_str().unwrap()))
        .collect();
    ensure!(
        actual == expected,
        "OpenSandbox egress rule readback mismatch"
    );
    Ok(())
}
pub(crate) fn verify_vault(readback: &Value, expected: &Value) -> Result<()> {
    let vault = readback.get("vault").unwrap_or(readback);
    ensure!(
        vault["revision"]
            .as_u64()
            .is_some_and(|revision| revision > 0),
        "OpenSandbox vault has no acknowledged revision"
    );
    for credential in vault["credentials"]
        .as_array()
        .ok_or_else(|| anyhow!("OpenSandbox vault credentials missing"))?
    {
        ensure!(
            credential.get("value").is_none() && credential.get("source").is_none(),
            "OpenSandbox vault readback exposed a value"
        );
        ensure!(
            credential["revision"]
                .as_u64()
                .is_some_and(|revision| revision > 0)
                && credential
                    .get("sourceType")
                    .or_else(|| credential.get("source_type"))
                    .and_then(Value::as_str)
                    == Some("inline"),
            "OpenSandbox credential is not ready"
        );
    }
    let names: BTreeSet<_> = vault
        .get("credentials")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("OpenSandbox vault credentials missing"))?
        .iter()
        .filter_map(|c| c["name"].as_str())
        .collect();
    let expected_names: BTreeSet<_> = expected["credentials"]
        .as_array()
        .unwrap()
        .iter()
        .filter_map(|c| c["name"].as_str())
        .collect();
    ensure!(
        names == expected_names,
        "OpenSandbox credential readback mismatch"
    );
    let bindings = vault
        .get("bindings")
        .and_then(Value::as_array)
        .ok_or_else(|| anyhow!("OpenSandbox credential bindings missing"))?;
    let expected_bindings = expected["bindings"].as_array().unwrap();
    ensure!(
        bindings.len() == expected_bindings.len(),
        "OpenSandbox binding readback mismatch"
    );
    for expected in expected_bindings {
        let binding = bindings
            .iter()
            .find(|b| b["name"] == expected["name"])
            .ok_or_else(|| anyhow!("OpenSandbox binding missing"))?;
        ensure!(
            binding["revision"]
                .as_u64()
                .is_some_and(|revision| revision > 0)
                && ["schemes", "hosts", "methods", "paths"]
                    .iter()
                    .all(|field| binding["match"][*field] == expected["match"][*field])
                && binding["auth"]["type"] == expected["auth"]["type"],
            "OpenSandbox binding scopes differ"
        );
        // The upstream sanitized metadata intentionally omits substitutions.
        // If a compatible provider does expose them, they must acknowledge the
        // exact requested mapping rather than a different credential or scope.
        if let Some(substitutions) = binding["auth"].get("substitutions") {
            ensure!(
                substitutions == &expected["auth"]["substitutions"],
                "OpenSandbox substitution mapping differs"
            );
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn policy_default_deny_and_vault_substitutions_are_scoped() {
        let spec = GovernedWorkspaceSpec {
            egress: EgressPolicy::AllowedHosts(vec!["api.example.com".into()]),
            credentials: vec![ProxyCredential {
                name: "token".into(),
                value: "secret-value".into(),
                placeholder: "__FAKE__".into(),
                hosts: vec!["api.example.com".into()],
            }],
        };
        assert_eq!(
            spec.network_policy(),
            json!({"defaultAction":"deny","egress":[{"action":"allow","target":"api.example.com"}]})
        );
        let vault = spec.credential_vault().unwrap();
        assert_eq!(vault["bindings"][0]["match"]["schemes"], json!(["https"]));
        assert_eq!(vault["bindings"][0]["auth"]["type"], "passthrough");
        assert!(!format!("{:?}", spec).contains("secret-value"));
    }
    #[test]
    fn overlapping_credential_scopes_fail_closed() {
        let credential = |host: &str, name: &str| ProxyCredential {
            name: name.into(),
            value: "secret".into(),
            placeholder: format!("__{name}__"),
            hosts: vec![host.into()],
        };
        let spec = GovernedWorkspaceSpec {
            egress: EgressPolicy::Unrestricted,
            credentials: vec![
                credential("*.example.com", "a"),
                credential("api.example.com", "b"),
            ],
        };
        assert!(spec.credential_vault().is_err());
        assert!(!valid_host("999.2.3.4"));
        assert!(!valid_host("*."));
        assert!(valid_host("192.168.1.1"));
    }
    #[test]
    fn policy_mismatch_blocks_readiness() {
        assert!(verify_policy(
            &json!({"defaultAction":"allow","egress":[]}),
            &json!({"defaultAction":"deny","egress":[]})
        )
        .is_err());
    }
}
