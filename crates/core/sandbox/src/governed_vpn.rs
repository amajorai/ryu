//! Isolated Tailscale HTTP egress for a single setup check.
//!
//! Primary contracts: Tailscale userspace networking + auth-key=file + state=mem;
//! OpenSandbox egress constants/configuration.go, docker/networking.py,
//! mitmproxy/cacert_export.go, and specs/egress-api.yaml. Only trusted helpers
//! hold the VPN identity or network administration capabilities.
use crate::governed::{verify_policy, verify_vault, EgressPolicy, GovernedWorkspaceSpec};
use crate::win_process::NoWindow;
use crate::ExecOutput;
use anyhow::{anyhow, ensure, Result};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    fs,
    io::Write,
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    process::Command,
    time::{sleep, timeout},
};

const OWNER: &str = "com.ryu.cloud-vpn";
const ROLE: &str = "com.ryu.cloud-vpn-role";
const DEADLINE: &str = "com.ryu.cloud-vpn-expiry";
const TOKEN_ENV: &str = "OPENSANDBOX_EGRESS_TOKEN";
const TOKEN_HEADER: &str = "OPENSANDBOX-EGRESS-AUTH";
const PUBLIC_CA: &str = "/opt/opensandbox/mitmproxy-ca-cert.pem";
const CAPTURE_LIMIT: usize = 1_048_576;
/// Cloud metadata and link-local destinations. A VPN that accepts subnet routes
/// can resolve these to a peer-advertised route, so they are refused ahead of
/// every approved rule: IPv4 link-local (EC2/GCP/Azure/Hetzner 169.254.169.254),
/// the EC2 IPv6 metadata address, and Alibaba Cloud metadata.
const METADATA_DENY_TARGETS: [&str; 3] = ["169.254.0.0/16", "fd00:ec2::254", "100.100.100.200"];

#[derive(Clone)]
pub struct GovernedVpnDocker {
    binary: OsString,
    workload_image: String,
    egress_image: String,
    tailscale_image: String,
    lease_root: PathBuf,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Lease {
    schema_version: u8,
    id: String,
    expires_at_unix_seconds: u64,
}
/// Credential-free handle. The workload shares only the trusted egress network.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GovernedVpnWorkspace {
    lease: Lease,
    policy: Value,
}
impl Lease {
    fn name(&self, role: &str) -> String {
        format!("ryu-cloud-vpn-{}-{role}", self.id)
    }
    fn validate(&self) -> Result<()> {
        let id =
            uuid::Uuid::parse_str(&self.id).map_err(|_| anyhow!("Invalid VPN resource lease"))?;
        ensure!(
            self.schema_version == 1
                && id.to_string() == self.id
                && self.expires_at_unix_seconds > 0,
            "Invalid VPN resource lease"
        );
        Ok(())
    }
}

struct CleanupGuard {
    backend: GovernedVpnDocker,
    lease: Lease,
    armed: bool,
}
impl Drop for CleanupGuard {
    fn drop(&mut self) {
        if !self.armed {
            return;
        }
        let backend = self.backend.clone();
        let lease = self.lease.clone();
        // Cancellation cannot await cleanup. Keep the durable lease even when
        // this attempt succeeds, so a late Docker create is recovered at expiry.
        std::thread::spawn(move || {
            if let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                let _ = runtime.block_on(backend.cleanup(&lease, false));
            }
        });
    }
}

impl GovernedVpnDocker {
    pub fn new(
        binary: OsString,
        workload_image: String,
        egress_image: String,
        tailscale_image: String,
        lease_root: PathBuf,
    ) -> Result<Self> {
        ensure!(
            !binary.is_empty()
                && lease_root.is_absolute()
                && lease_root
                    .to_str()
                    .is_some_and(|path| !path.contains([',', '\n', '\r'])),
            "VPN runtime needs an explicit binary and absolute lease directory"
        );
        for image in [&workload_image, &egress_image, &tailscale_image] {
            validate_image(image)?;
        }
        Ok(Self {
            binary,
            workload_image,
            egress_image,
            tailscale_image,
            lease_root,
        })
    }

    async fn call(
        &self,
        arguments: &[OsString],
        input: Option<&[u8]>,
        token: Option<&str>,
        seconds: u64,
    ) -> Result<ExecOutput> {
        let mut command = Command::new(&self.binary);
        command
            .args(arguments)
            .no_window()
            .kill_on_drop(true)
            .stdin(if input.is_some() {
                std::process::Stdio::piped()
            } else {
                std::process::Stdio::null()
            })
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(token) = token {
            command.env(TOKEN_ENV, token);
        }
        let run = async {
            let mut child = command
                .spawn()
                .map_err(|_| anyhow!("VPN Docker runtime is unavailable"))?;
            let stdout = tokio::spawn(capture(
                child
                    .stdout
                    .take()
                    .ok_or_else(|| anyhow!("VPN runtime stdout unavailable"))?,
            ));
            let stderr = tokio::spawn(capture(
                child
                    .stderr
                    .take()
                    .ok_or_else(|| anyhow!("VPN runtime stderr unavailable"))?,
            ));
            if let Some(bytes) = input {
                if let Some(mut writer) = child.stdin.take() {
                    writer.write_all(bytes).await?;
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
            .map_err(|_| anyhow!("VPN runtime operation timed out"))?
    }

    async fn checked(
        &self,
        arguments: Vec<OsString>,
        input: Option<&[u8]>,
        token: Option<&str>,
    ) -> Result<Vec<u8>> {
        let output = self.call(&arguments, input, token, 30).await?;
        // Helpers can receive secrets. Never promote their raw output into errors.
        ensure!(output.exit_code == 0, "VPN runtime operation failed");
        ensure!(
            output.stdout.len() <= CAPTURE_LIMIT,
            "VPN runtime response exceeded limit"
        );
        Ok(output.stdout)
    }

    async fn json(&self, arguments: Vec<OsString>) -> Result<Value> {
        let output = self.checked(arguments, None, None).await?;
        serde_json::from_slice(&output)
            .map_err(|_| anyhow!("VPN runtime returned invalid metadata"))
    }

    async fn require_rootless(&self) -> Result<()> {
        let info = self.json(args(&["info", "--format", "{{json .}}"])).await?;
        ensure!(
            info["OSType"] == "linux"
                && info["SecurityOptions"]
                    .as_array()
                    .is_some_and(
                        |options| options.iter().any(|entry| entry
                            .as_str()
                            .is_some_and(|entry| entry == "name=rootless"
                                || entry.starts_with("name=rootless,")))
                    ),
            "Isolated VPN setup requires an existing rootless Linux Docker daemon"
        );
        Ok(())
    }
    async fn preflight(&self) -> Result<()> {
        self.require_rootless().await?;
        for image in [
            &self.workload_image,
            &self.egress_image,
            &self.tailscale_image,
        ] {
            let inspected = self.json(args(&["image", "inspect", image])).await?;
            ensure!(
                inspected
                    .as_array()
                    .is_some_and(|entries| entries.len() == 1
                        && entries[0]["Id"]
                            .as_str()
                            .is_some_and(|id| id.starts_with("sha256:"))),
                "VPN images must already be loaded locally"
            );
        }
        fs::create_dir_all(&self.lease_root)?;
        ensure!(
            !fs::symlink_metadata(&self.lease_root)?
                .file_type()
                .is_symlink(),
            "VPN lease directory cannot be a symlink"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&self.lease_root, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }

    fn persist_lease(&self, seconds: u64) -> Result<Lease> {
        let lease = Lease {
            schema_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            expires_at_unix_seconds: now()?
                .checked_add(seconds + 600)
                .ok_or_else(|| anyhow!("VPN deadline overflow"))?,
        };
        let mut file = tempfile::NamedTempFile::new_in(&self.lease_root)?;
        file.write_all(&serde_json::to_vec(&lease)?)?;
        file.as_file().sync_all()?;
        file.persist_noclobber(self.lease_root.join(format!("{}.json", lease.id)))
            .map_err(|_| anyhow!("Could not persist VPN resource lease"))?;
        Ok(lease)
    }

    /// Expired leases carry no credential values. All names are derived from the
    /// UUID and each resource's exact owner/role/deadline labels are checked.
    pub async fn recover_expired(&self) -> Result<usize> {
        if !self.lease_root.exists() {
            return Ok(0);
        }
        self.require_rootless().await?;
        ensure!(
            !fs::symlink_metadata(&self.lease_root)?
                .file_type()
                .is_symlink(),
            "VPN lease directory cannot be a symlink"
        );
        let mut recovered = 0;
        let mut visited = 0;
        for entry in fs::read_dir(&self.lease_root)? {
            visited += 1;
            ensure!(visited <= 1000, "VPN lease inventory exceeded limit");
            let entry = entry?;
            let metadata = fs::symlink_metadata(entry.path())?;
            if !metadata.is_file()
                || metadata.file_type().is_symlink()
                || entry.path().extension().and_then(|value| value.to_str()) != Some("json")
            {
                continue;
            }
            ensure!(metadata.len() <= 4096, "VPN lease metadata exceeded limit");
            let lease: Lease = serde_json::from_slice(&fs::read(entry.path())?)
                .map_err(|_| anyhow!("Invalid VPN resource lease"))?;
            lease.validate()?;
            ensure!(
                entry.file_name().to_str() == Some(&format!("{}.json", lease.id)),
                "VPN lease name mismatch"
            );
            if lease.expires_at_unix_seconds <= now()? {
                self.cleanup(&lease, true).await?;
                recovered += 1;
            }
        }
        Ok(recovered)
    }

    pub async fn run_setup(
        &self,
        spec: &GovernedWorkspaceSpec,
        auth_key: &str,
        script: &str,
        seconds: u64,
    ) -> Result<ExecOutput> {
        ensure!(
            !matches!(spec.egress, EgressPolicy::Denied),
            "VPN setup cannot enable outbound access when internet access is disabled"
        );
        ensure!(
            auth_key.starts_with("tskey-auth-")
                && auth_key.len() <= 1024
                && auth_key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
            "A reusable Tailscale auth key is required"
        );
        ensure!(
            script.len() <= 1_048_576 && (1..=1800).contains(&seconds),
            "VPN setup input exceeds limits"
        );
        ensure!(
            !script.contains(auth_key)
                && !spec
                    .credentials
                    .iter()
                    .any(|credential| credential.value.contains(auth_key)),
            "VPN auth keys cannot be exposed to the workload"
        );
        let workspace = self.create_workspace(spec, auth_key, seconds).await?;
        let result = self.execute_script(&workspace, script, seconds).await;
        let cleanup = self.destroy_workspace(&workspace).await;
        match (result, cleanup) {
            (Ok(output), Ok(())) => Ok(output),
            (Err(error), Ok(())) => Err(error),
            (_, Err(_)) => Err(anyhow!(
                "VPN setup cleanup failed; the durable lease remains for recovery"
            )),
        }
    }

    /// Prepare an isolated identity and verified workload without running user code.
    pub async fn create_workspace(
        &self,
        spec: &GovernedWorkspaceSpec,
        auth_key: &str,
        lifetime_seconds: u64,
    ) -> Result<GovernedVpnWorkspace> {
        ensure!(
            !matches!(spec.egress, EgressPolicy::Denied),
            "VPN requires enabled internet access"
        );
        ensure!(
            auth_key.starts_with("tskey-auth-")
                && auth_key.len() <= 1024
                && auth_key
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
            "A reusable Tailscale auth key is required"
        );
        ensure!(
            (1..=86_400).contains(&lifetime_seconds),
            "VPN workspace lifetime exceeds limits"
        );
        ensure!(
            !spec
                .credentials
                .iter()
                .any(|credential| credential.value.contains(auth_key)),
            "VPN auth keys cannot be exposed to the workload"
        );
        let vault = spec.credential_vault()?;
        self.preflight().await?;
        self.recover_expired().await?;
        let lease = self.persist_lease(lifetime_seconds)?;
        let mut guard = CleanupGuard {
            backend: self.clone(),
            lease: lease.clone(),
            armed: true,
        };
        let result = timeout(
            Duration::from_secs(240),
            self.prepare_workspace(&lease, spec, &vault, auth_key),
        )
        .await
        .unwrap_or_else(|_| Err(anyhow!("VPN setup exceeded its operation deadline")));
        if result.is_ok() {
            guard.armed = false;
            return Ok(GovernedVpnWorkspace {
                lease,
                policy: vpn_network_policy(spec),
            });
        }
        if self.cleanup(&lease, false).await.is_ok() {
            guard.armed = false;
        }
        Err(result
            .err()
            .unwrap_or_else(|| anyhow!("VPN preparation failed")))
    }

    pub async fn execute_script(
        &self,
        workspace: &GovernedVpnWorkspace,
        script: &str,
        seconds: u64,
    ) -> Result<ExecOutput> {
        workspace.lease.validate()?;
        ensure!(
            workspace.lease.expires_at_unix_seconds > now()?,
            "VPN workspace expired"
        );
        ensure!(
            script.len() <= 1_048_576 && (1..=1800).contains(&seconds),
            "VPN execution input exceeds limits"
        );
        self.require_rootless().await?;
        let workload = workspace.lease.name("workload");
        let egress = self.inspect(&workspace.lease.name("egress")).await?;
        let network_name = workspace.lease.name("network");
        verify_container(
            &egress,
            &workspace.lease,
            "egress",
            &network_name,
            None,
            false,
        )?;
        let token = egress["Config"]["Env"]
            .as_array()
            .and_then(|values| {
                values
                    .iter()
                    .filter_map(Value::as_str)
                    .find_map(|value| value.strip_prefix("OPENSANDBOX_EGRESS_TOKEN="))
            })
            .filter(|value| !value.is_empty())
            .ok_or_else(|| anyhow!("VPN control-plane identity unavailable"))?;
        let bindings = egress["NetworkSettings"]["Ports"]["18080/tcp"]
            .as_array()
            .filter(|bindings| bindings.len() == 1 && bindings[0]["HostIp"] == "127.0.0.1")
            .ok_or_else(|| anyhow!("VPN control-plane endpoint must remain loopback-only"))?;
        let port = bindings[0]["HostPort"]
            .as_str()
            .and_then(|port| port.parse::<u16>().ok())
            .filter(|port| *port > 0)
            .ok_or_else(|| anyhow!("VPN control-plane endpoint unavailable"))?;
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()?;
        let policy = api_json(
            &client,
            &format!("http://127.0.0.1:{port}"),
            token,
            "policy",
            None,
        )
        .await?;
        verify_policy(&policy, &workspace.policy)?;
        let network = format!(
            "container:{}",
            egress["Id"]
                .as_str()
                .ok_or_else(|| anyhow!("VPN egress identity unavailable"))?
        );
        let inspected = self.inspect(&workload).await?;
        verify_container(
            &inspected,
            &workspace.lease,
            "workload",
            &network,
            Some("1000:1000"),
            true,
        )?;
        self.call(
            &args(&["exec", "-i", "--user", "1000:1000", &workload, "sh", "-s"]),
            Some(script.as_bytes()),
            None,
            seconds,
        )
        .await
    }

    pub async fn destroy_workspace(&self, workspace: &GovernedVpnWorkspace) -> Result<()> {
        workspace.lease.validate()?;
        self.require_rootless().await?;
        self.cleanup(&workspace.lease, true).await
    }

    async fn prepare_workspace(
        &self,
        lease: &Lease,
        spec: &GovernedWorkspaceSpec,
        vault: &Value,
        auth_key: &str,
    ) -> Result<()> {
        let network = lease.name("network");
        let tail = lease.name("tailscale");
        let egress = lease.name("egress");
        let workload = lease.name("workload");
        let mut network_args = args(&["network", "create"]);
        labels(&mut network_args, lease, "network");
        network_args.push(network.clone().into());
        self.checked(network_args, None, None).await?;
        let mut tail_args = create_args(lease, "tailscale");
        tail_args.extend(args(&[
            "--network",
            &network,
            "--user",
            "1000:1000",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,mode=1777",
            "--entrypoint",
            "tailscaled",
            "--",
            &self.tailscale_image,
            "--tun=userspace-networking",
            "--state=mem:",
            "--statedir=/tmp/tailscale",
            "--socket=/tmp/tailscaled.sock",
            "--outbound-http-proxy-listen=0.0.0.0:1055",
        ]));
        self.checked(tail_args, None, None).await?;
        self.checked(args(&["start", &tail]), None, None).await?;
        let mut socket_ready = false;
        for _ in 0..30 {
            if self
                .call(
                    &args(&[
                        "exec",
                        "--user",
                        "1000:1000",
                        &tail,
                        "sh",
                        "-c",
                        "test -S /tmp/tailscaled.sock",
                    ]),
                    None,
                    None,
                    3,
                )
                .await?
                .exit_code
                == 0
            {
                socket_ready = true;
                break;
            }
            sleep(Duration::from_millis(200)).await;
        }
        ensure!(socket_ready, "The isolated Tailscale daemon is not ready");
        let auth_script = b"umask 077\ntrap 'rm -f /tmp/ryu-authkey' EXIT\ncat > /tmp/ryu-authkey\ntailscale --socket=/tmp/tailscaled.sock up --auth-key=file:/tmp/ryu-authkey --accept-routes=true --accept-dns=false --shields-up --timeout=30s\n";
        // The fixed helper script and key are separate streams: the key is stdin,
        // not interpolated into a shell command, an environment, or any argv.
        self.checked(
            args(&[
                "exec",
                "-i",
                "--user",
                "1000:1000",
                &tail,
                "sh",
                "-c",
                "umask 077; cat > /tmp/ryu-vpn-auth.sh",
            ]),
            Some(auth_script),
            None,
        )
        .await?;
        self.checked(
            args(&[
                "exec",
                "-i",
                "--user",
                "1000:1000",
                &tail,
                "sh",
                "/tmp/ryu-vpn-auth.sh",
            ]),
            Some(auth_key.as_bytes()),
            None,
        )
        .await?;
        // Also erase the fixed script once enrollment completes.
        self.checked(
            args(&[
                "exec",
                "--user",
                "1000:1000",
                &tail,
                "rm",
                "-f",
                "/tmp/ryu-authkey",
                "/tmp/ryu-vpn-auth.sh",
            ]),
            None,
            None,
        )
        .await?;
        let tail_state = self
            .json(args(&[
                "exec",
                "--user",
                "1000:1000",
                &tail,
                "tailscale",
                "--socket=/tmp/tailscaled.sock",
                "status",
                "--json",
            ]))
            .await?;
        ensure!(
            tail_state["BackendState"] == "Running",
            "The isolated Tailscale identity is not connected"
        );
        let tail_inspect = self.inspect(&tail).await?;
        verify_container(
            &tail_inspect,
            lease,
            "tailscale",
            &network,
            Some("1000:1000"),
            true,
        )?;
        let proxy_ip = tail_inspect["NetworkSettings"]["Networks"][&network]["IPAddress"]
            .as_str()
            .ok_or_else(|| anyhow!("VPN helper has no private address"))?
            .parse::<std::net::Ipv4Addr>()
            .map_err(|_| anyhow!("Invalid VPN helper address"))?;
        ensure!(proxy_ip.is_private(), "VPN helper address must be private");
        let token = uuid::Uuid::new_v4().to_string();
        let upstream = format!("http://{proxy_ip}:1055");
        let policy = serde_json::to_string(&vpn_network_policy(spec))?;
        let mut egress_args = create_args(lease, "egress");
        egress_args.extend(args(&[
            "--network",
            &network,
            "--cap-drop",
            "ALL",
            "--cap-add",
            "NET_ADMIN",
            "--cap-add",
            "SETUID",
            "--cap-add",
            "SETGID",
            "--security-opt",
            "no-new-privileges",
            "--publish",
            "127.0.0.1::18080",
            "--env",
            TOKEN_ENV,
            "--env",
            "OPENSANDBOX_EGRESS_MODE=dns+nft",
            "--env",
            "OPENSANDBOX_EGRESS_MITMPROXY_TRANSPARENT=true",
            "--env",
            "OPENSANDBOX_EGRESS_BLOCK_DOH_443=true",
            "--env",
            &format!("OPENSANDBOX_EGRESS_RULES={policy}"),
            "--env",
            &format!("OPENSANDBOX_EGRESS_UPSTREAM_PROXY={upstream}"),
            "--",
            &self.egress_image,
        ]));
        self.checked(egress_args, None, Some(&token)).await?;
        self.checked(args(&["start", &egress]), None, None).await?;
        let egress_inspect = self.inspect(&egress).await?;
        let egress_id = egress_inspect["Id"]
            .as_str()
            .filter(|id| id.len() == 64 && id.bytes().all(|byte| byte.is_ascii_hexdigit()))
            .ok_or_else(|| anyhow!("Invalid VPN egress identity"))?;
        let workload_network = format!("container:{egress_id}");
        verify_container(&egress_inspect, lease, "egress", &network, None, false)?;
        verify_egress_environment(&egress_inspect, &upstream, &token, &policy)?;
        let proxy_uid = self
            .checked(
                args(&["exec", &egress, "id", "-u", "mitmproxy"]),
                None,
                None,
            )
            .await?;
        let proxy_uid = std::str::from_utf8(&proxy_uid)
            .ok()
            .and_then(|value| value.trim().parse::<u32>().ok())
            .ok_or_else(|| anyhow!("VPN proxy user metadata unavailable"))?;
        ensure!(
            proxy_uid != 0 && proxy_uid != 1000,
            "VPN workload must not share the trusted proxy's UID"
        );
        let bindings = egress_inspect["NetworkSettings"]["Ports"]["18080/tcp"]
            .as_array()
            .ok_or_else(|| anyhow!("VPN policy endpoint is unavailable"))?;
        ensure!(
            bindings.len() == 1 && bindings[0]["HostIp"] == "127.0.0.1",
            "VPN policy endpoint must be bound to loopback only"
        );
        let port = bindings[0]["HostPort"]
            .as_str()
            .and_then(|port| port.parse::<u16>().ok())
            .filter(|port| *port > 0)
            .ok_or_else(|| anyhow!("Invalid VPN policy endpoint"))?;
        let base = format!("http://127.0.0.1:{port}");
        let client = reqwest::Client::builder()
            .no_proxy()
            .redirect(reqwest::redirect::Policy::none())
            .timeout(Duration::from_secs(3))
            .build()?;
        let unauthorized = client
            .get(format!("{base}/policy"))
            .send()
            .await
            .map_err(|_| anyhow!("VPN policy endpoint is unreachable"))?;
        ensure!(
            unauthorized.status() == reqwest::StatusCode::UNAUTHORIZED,
            "VPN policy endpoint failed its unauthorized-access check"
        );
        let mut ready = false;
        for _ in 0..30 {
            if let Ok(response) = client
                .get(format!("{base}/healthz"))
                .header(TOKEN_HEADER, &token)
                .send()
                .await
            {
                if response.status().is_success() {
                    ready = true;
                    break;
                }
            }
            sleep(Duration::from_millis(200)).await;
        }
        ensure!(ready, "VPN packet enforcement did not become ready");
        let policy_readback = api_json(&client, &base, &token, "policy", None).await?;
        verify_policy(&policy_readback, &vpn_network_policy(spec))?;
        if !spec.credentials.is_empty() {
            api_json(&client, &base, &token, "credential-vault", Some(vault)).await?;
            let readback = api_json(&client, &base, &token, "credential-vault", None).await?;
            verify_vault(&readback, vault)?;
        }
        let ca = self
            .checked(args(&["exec", &egress, "cat", PUBLIC_CA]), None, None)
            .await?;
        ensure!(
            ca.len() <= 65_536
                && std::str::from_utf8(&ca)
                    .is_ok_and(|text| text.contains("-----BEGIN CERTIFICATE-----")
                        && !text.contains("PRIVATE KEY")),
            "VPN provider did not export a public CA certificate"
        );
        let ca_path = self.lease_root.join(format!("{}.ca.pem", lease.id));
        let mut ca_file = tempfile::NamedTempFile::new_in(&self.lease_root)?;
        ca_file.write_all(&ca)?;
        ca_file.as_file().sync_all()?;
        ca_file
            .persist_noclobber(&ca_path)
            .map_err(|_| anyhow!("VPN public CA delivery failed"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&ca_path, fs::Permissions::from_mode(0o644))?;
        }
        let mut workload_args = create_args(lease, "workload");
        workload_args.extend(args(&[
            "--network",
            &workload_network,
            "--user",
            "1000:1000",
            "--read-only",
            "--cap-drop",
            "ALL",
            "--security-opt",
            "no-new-privileges",
            "--pids-limit",
            "256",
            "--memory",
            "2g",
            "--cpus",
            "2",
            "--tmpfs",
            "/tmp:rw,nosuid,nodev,uid=1000,gid=1000",
            "--tmpfs",
            "/workspace:rw,nosuid,nodev,uid=1000,gid=1000",
            "--workdir",
            "/workspace",
            "--mount",
            &format!(
                "type=bind,src={},dst=/run/ryu/ca.pem,readonly",
                ca_path.to_string_lossy()
            ),
            "--env",
            "SSL_CERT_FILE=/run/ryu/ca.pem",
            "--env",
            "REQUESTS_CA_BUNDLE=/run/ryu/ca.pem",
            "--env",
            "NODE_EXTRA_CA_CERTS=/run/ryu/ca.pem",
            "--env",
            "GIT_SSL_CAINFO=/run/ryu/ca.pem",
            "--entrypoint",
            "sleep",
            "--",
            &self.workload_image,
            "infinity",
        ]));
        self.checked(workload_args, None, None).await?;
        self.checked(args(&["start", &workload]), None, None)
            .await?;
        let workload_inspect = self.inspect(&workload).await?;
        verify_container(
            &workload_inspect,
            lease,
            "workload",
            &workload_network,
            Some("1000:1000"),
            true,
        )?;
        ensure!(
            workload_inspect["Mounts"]
                .as_array()
                .is_some_and(|mounts| mounts.iter().all(|mount| mount["Type"] == "tmpfs"
                    || (mount["Type"] == "bind"
                        && mount["Destination"] == "/run/ryu/ca.pem"
                        && mount["Source"] == ca_path.to_string_lossy().as_ref()
                        && mount["RW"] == false))),
            "VPN workload must mount only its public CA certificate"
        );
        self.checked(
            args(&[
                "exec",
                "--user",
                "1000:1000",
                &workload,
                "curl",
                "--version",
            ]),
            None,
            None,
        )
        .await?;
        let direct = self
            .call(
                &args(&[
                    "exec",
                    "--user",
                    "1000:1000",
                    &workload,
                    "curl",
                    "--noproxy",
                    "*",
                    "--connect-timeout",
                    "2",
                    "--max-time",
                    "3",
                    "--output",
                    "/dev/null",
                    "--silent",
                    "--show-error",
                    &format!("http://{proxy_ip}:1055/"),
                ]),
                None,
                None,
                10,
            )
            .await?;
        ensure!(
            direct.exit_code == 7 || direct.exit_code == 28,
            "VPN workload can reach the trusted proxy directly or containment could not be proven"
        );
        // All invariant readbacks precede user-script execution. /bin/sh and
        // Git/tool dependencies must already exist in the operator's image.
        Ok(())
    }

    async fn inspect(&self, name: &str) -> Result<Value> {
        let value = self.json(args(&["container", "inspect", name])).await?;
        let entries = value
            .as_array()
            .ok_or_else(|| anyhow!("Invalid VPN container metadata"))?;
        ensure!(entries.len() == 1, "Invalid VPN container metadata");
        Ok(entries[0].clone())
    }

    async fn cleanup(&self, lease: &Lease, remove_lease: bool) -> Result<()> {
        lease.validate()?;
        let mut failed = false;
        for role in ["workload", "egress", "tailscale"] {
            if self.cleanup_container(lease, role).await.is_err() {
                failed = true;
            }
        }
        if self.cleanup_network(lease).await.is_err() {
            failed = true;
        }
        ensure!(
            !failed,
            "VPN resource cleanup failed; owned leases remain for recovery"
        );
        let ca = self.lease_root.join(format!("{}.ca.pem", lease.id));
        if ca.exists() {
            fs::remove_file(ca)?;
        }
        if remove_lease {
            fs::remove_file(self.lease_root.join(format!("{}.json", lease.id)))?;
        }
        Ok(())
    }
    async fn cleanup_container(&self, lease: &Lease, role: &str) -> Result<()> {
        let name = lease.name(role);
        let probe = self
            .call(&args(&["container", "inspect", &name]), None, None, 10)
            .await?;
        if probe.exit_code != 0 {
            // Distinguish absence from a daemon outage. Never delete the
            // durable lease while Docker cannot enumerate owned resources.
            let output = self
                .call(
                    &args(&[
                        "container",
                        "ls",
                        "--all",
                        "--filter",
                        &format!("name=^/{name}$"),
                        "--format",
                        "{{json .}}",
                    ]),
                    None,
                    None,
                    10,
                )
                .await?;
            ensure!(
                output.exit_code == 0 && output.stdout.iter().all(u8::is_ascii_whitespace),
                "VPN cleanup could not verify resource absence"
            );
            return Ok(());
        }
        let records: Value = serde_json::from_slice(&probe.stdout)
            .map_err(|_| anyhow!("Invalid VPN cleanup metadata"))?;
        let container = records
            .as_array()
            .and_then(|entries| {
                if entries.len() == 1 {
                    entries.first()
                } else {
                    None
                }
            })
            .ok_or_else(|| anyhow!("Invalid VPN cleanup metadata"))?;
        verify_labels(&container["Config"]["Labels"], lease, role)?;
        ensure!(
            container["Name"] == format!("/{name}"),
            "VPN cleanup container name mismatch"
        );
        if role == "tailscale" {
            let _ = self
                .call(
                    &args(&[
                        "exec",
                        "--user",
                        "1000:1000",
                        &name,
                        "tailscale",
                        "--socket=/tmp/tailscaled.sock",
                        "logout",
                    ]),
                    None,
                    None,
                    10,
                )
                .await;
        }
        self.checked(args(&["rm", "--force", "--volumes", &name]), None, None)
            .await?;
        Ok(())
    }
    async fn cleanup_network(&self, lease: &Lease) -> Result<()> {
        let network = lease.name("network");
        let probe = self
            .call(&args(&["network", "inspect", &network]), None, None, 10)
            .await?;
        if probe.exit_code == 0 {
            let value: Value = serde_json::from_slice(&probe.stdout)
                .map_err(|_| anyhow!("Invalid VPN network metadata"))?;
            let record = value
                .as_array()
                .and_then(|entries| {
                    if entries.len() == 1 {
                        entries.first()
                    } else {
                        None
                    }
                })
                .ok_or_else(|| anyhow!("Invalid VPN network metadata"))?;
            verify_labels(&record["Labels"], lease, "network")?;
            ensure!(
                record["Name"] == network,
                "VPN cleanup network name mismatch"
            );
            self.checked(args(&["network", "rm", &network]), None, None)
                .await?;
        } else {
            let output = self
                .call(
                    &args(&[
                        "network",
                        "ls",
                        "--filter",
                        &format!("name=^{network}$"),
                        "--format",
                        "{{json .}}",
                    ]),
                    None,
                    None,
                    10,
                )
                .await?;
            ensure!(
                output.exit_code == 0 && output.stdout.iter().all(u8::is_ascii_whitespace),
                "VPN cleanup could not verify network absence"
            );
        }
        Ok(())
    }
}

/// The user-approved workspace policy with the metadata deny rules prepended.
/// Egress rules are evaluated in order, so the denies precede any allow (even
/// an approved host that is itself a metadata address) and apply under both a
/// default-deny and a default-allow policy. `accept-routes` stays on: reaching
/// subnet-routed private destinations is the point of the VPN.
fn vpn_network_policy(spec: &GovernedWorkspaceSpec) -> Value {
    let mut policy = spec.network_policy();
    if let Some(rules) = policy["egress"].as_array_mut() {
        rules.splice(
            0..0,
            METADATA_DENY_TARGETS
                .iter()
                .map(|target| json!({"action": "deny", "target": target})),
        );
    }
    policy
}
fn args(values: &[&str]) -> Vec<OsString> {
    values.iter().map(OsString::from).collect()
}
fn labels(arguments: &mut Vec<OsString>, lease: &Lease, role: &str) {
    for value in [
        format!("{OWNER}={}", lease.id),
        format!("{ROLE}={role}"),
        format!("{DEADLINE}={}", lease.expires_at_unix_seconds),
    ] {
        arguments.extend(["--label".into(), value.into()]);
    }
}
fn create_args(lease: &Lease, role: &str) -> Vec<OsString> {
    let mut result = args(&["create", "--pull", "never", "--name", &lease.name(role)]);
    labels(&mut result, lease, role);
    result
}
fn validate_image(image: &str) -> Result<()> {
    ensure!(
        image.len() <= 512
            && image.starts_with(|character: char| character.is_ascii_alphanumeric())
            && image
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || b"._-/:@".contains(&byte)),
        "Invalid VPN runtime image"
    );
    let last = image.rsplit('/').next().unwrap_or("");
    ensure!(
        image.contains("@sha256:")
            || last
                .rsplit_once(':')
                .is_some_and(|(_, tag)| !tag.is_empty() && tag != "latest"),
        "VPN runtime images must use a pinned version or digest"
    );
    Ok(())
}
fn now() -> Result<u64> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_secs())
        .map_err(|_| anyhow!("Invalid VPN runtime clock"))
}
fn verify_labels(labels: &Value, lease: &Lease, role: &str) -> Result<()> {
    ensure!(
        labels[OWNER] == lease.id
            && labels[ROLE] == role
            && labels[DEADLINE] == lease.expires_at_unix_seconds.to_string(),
        "VPN resource ownership mismatch"
    );
    Ok(())
}
fn verify_container(
    container: &Value,
    lease: &Lease,
    role: &str,
    network: &str,
    user: Option<&str>,
    read_only: bool,
) -> Result<()> {
    verify_labels(&container["Config"]["Labels"], lease, role)?;
    ensure!(
        container["Name"] == format!("/{}", lease.name(role))
            && container["State"]["Running"] == true
            && container["HostConfig"]["NetworkMode"] == network,
        "VPN container isolation mismatch"
    );
    ensure!(
        container["HostConfig"]["Privileged"] == false
            && container["HostConfig"]["PidMode"]
                .as_str()
                .is_some_and(str::is_empty),
        "VPN container cannot share host or peer process access"
    );
    ensure!(
        container["HostConfig"]["CapDrop"]
            .as_array()
            .is_some_and(|values| values.iter().any(|value| value
                .as_str()
                .is_some_and(|value| value.eq_ignore_ascii_case("ALL")))),
        "VPN container must drop default capabilities"
    );
    // Docker Engine 20.10+ normalizes `--cap-add NET_ADMIN` to `CAP_NET_ADMIN`
    // in inspect output; compare canonical names so either spelling verifies.
    let added = container["HostConfig"]["CapAdd"]
        .as_array()
        .map(|values| {
            values
                .iter()
                .filter_map(Value::as_str)
                .map(canonical_capability)
                .collect::<std::collections::BTreeSet<_>>()
        })
        .unwrap_or_default();
    let expected = if role == "egress" {
        ["NET_ADMIN", "SETUID", "SETGID"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    } else {
        std::collections::BTreeSet::new()
    };
    ensure!(added == expected, "VPN container capabilities mismatch");
    ensure!(
        container["HostConfig"]["SecurityOpt"]
            .as_array()
            .is_some_and(|values| values
                .iter()
                .any(|value| value == "no-new-privileges" || value == "no-new-privileges=true")),
        "VPN container privilege escalation must be disabled"
    );
    if let Some(user) = user {
        ensure!(
            container["Config"]["User"] == user
                && container["HostConfig"]["ReadonlyRootfs"] == read_only,
            "VPN container user or filesystem isolation mismatch"
        );
    }
    let mounts = container["Mounts"]
        .as_array()
        .ok_or_else(|| anyhow!("VPN mount metadata missing"))?;
    ensure!(
        mounts.iter().all(|mount| mount["Type"] == "tmpfs"
            || (role == "workload"
                && mount["Destination"] == "/run/ryu/ca.pem"
                && mount["RW"] == false)),
        "VPN container has an unexpected host mount"
    );
    Ok(())
}
fn canonical_capability(name: &str) -> String {
    let upper = name.to_ascii_uppercase();
    upper
        .strip_prefix("CAP_")
        .map_or_else(|| upper.clone(), str::to_owned)
}
/// Read back the egress container's runtime environment and require every value
/// the creation step set: the per-lease token, the enforcement mode, transparent
/// interception, DoH-on-443 blocking, the exact policy rules, and the upstream
/// proxy. Each key must appear exactly once with exactly the expected value, so
/// a second (overriding) definition or a missing entry fails closed.
fn verify_egress_environment(
    container: &Value,
    upstream: &str,
    token: &str,
    rules: &str,
) -> Result<()> {
    let env = container["Config"]["Env"]
        .as_array()
        .ok_or_else(|| anyhow!("VPN egress metadata missing"))?;
    let entries = env
        .iter()
        .map(|value| {
            value
                .as_str()
                .ok_or_else(|| anyhow!("VPN egress runtime configuration mismatch"))
        })
        .collect::<Result<Vec<_>>>()?;
    for (key, expected) in [
        (TOKEN_ENV, token),
        ("OPENSANDBOX_EGRESS_MODE", "dns+nft"),
        ("OPENSANDBOX_EGRESS_MITMPROXY_TRANSPARENT", "true"),
        ("OPENSANDBOX_EGRESS_BLOCK_DOH_443", "true"),
        ("OPENSANDBOX_EGRESS_RULES", rules),
        ("OPENSANDBOX_EGRESS_UPSTREAM_PROXY", upstream),
    ] {
        let mut values = entries.iter().filter_map(|entry| {
            entry
                .split_once('=')
                .filter(|(name, _)| *name == key)
                .map(|(_, value)| value)
        });
        ensure!(
            values.next() == Some(expected) && values.next().is_none(),
            "VPN egress runtime configuration mismatch"
        );
    }
    ensure!(
        !env.iter().filter_map(Value::as_str).any(|value| value
            .starts_with("OPENSANDBOX_EGRESS_MITMPROXY_SSL_INSECURE=")
            && !value.ends_with("=false")),
        "VPN runtime cannot disable TLS verification"
    );
    Ok(())
}
async fn api_json(
    client: &reqwest::Client,
    base: &str,
    token: &str,
    endpoint: &str,
    payload: Option<&Value>,
) -> Result<Value> {
    let builder = if let Some(payload) = payload {
        client.post(format!("{base}/{endpoint}")).json(payload)
    } else {
        client.get(format!("{base}/{endpoint}"))
    };
    let mut response = builder
        .header(TOKEN_HEADER, token)
        .send()
        .await
        .map_err(|_| anyhow!("VPN policy service request failed"))?;
    ensure!(
        response.status().is_success(),
        "VPN policy service refused the request"
    );
    ensure!(
        response
            .content_length()
            .is_none_or(|length| length <= CAPTURE_LIMIT as u64),
        "VPN policy metadata exceeded limit"
    );
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| anyhow!("VPN policy metadata unreadable"))?
    {
        ensure!(
            bytes.len().saturating_add(chunk.len()) <= CAPTURE_LIMIT,
            "VPN policy metadata exceeded limit"
        );
        bytes.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&bytes).map_err(|_| anyhow!("Invalid VPN policy metadata"))
}
async fn capture<R: tokio::io::AsyncRead + Unpin>(mut reader: R) -> Result<Vec<u8>> {
    let mut result = Vec::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = reader.read(&mut buffer).await?;
        if count == 0 {
            break;
        }
        let remaining = (CAPTURE_LIMIT + 1).saturating_sub(result.len());
        result.extend_from_slice(&buffer[..count.min(remaining)]);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn metadata_destinations_are_denied_ahead_of_every_approved_rule() {
        let deny: Vec<Value> = METADATA_DENY_TARGETS
            .iter()
            .map(|target| json!({"action": "deny", "target": target}))
            .collect();
        for target in ["169.254.0.0/16", "fd00:ec2::254", "100.100.100.200"] {
            assert!(METADATA_DENY_TARGETS.contains(&target));
        }
        let spec = |egress| GovernedWorkspaceSpec {
            egress,
            credentials: Vec::new(),
        };
        // Allow-all, deny-all and an allowlist that even names a metadata address:
        // the default action is untouched and the denies come first.
        let unrestricted = vpn_network_policy(&spec(EgressPolicy::Unrestricted));
        assert_eq!(unrestricted["defaultAction"], "allow");
        assert_eq!(unrestricted["egress"], json!(deny));
        let denied = vpn_network_policy(&spec(EgressPolicy::Denied));
        assert_eq!(denied["defaultAction"], "deny");
        assert_eq!(denied["egress"], json!(deny));
        let hosts = vec!["api.example.com".to_string(), "169.254.169.254".to_string()];
        let allowed = vpn_network_policy(&spec(EgressPolicy::AllowedHosts(hosts)));
        assert_eq!(allowed["defaultAction"], "deny");
        let rules = allowed["egress"].as_array().unwrap();
        assert_eq!(rules.len(), deny.len() + 2);
        assert_eq!(&rules[..deny.len()], deny.as_slice());
        assert!(rules[deny.len()..]
            .iter()
            .all(|rule| rule["action"] == "allow"));
    }
    #[test]
    fn metadata_denies_are_part_of_the_attested_policy_readback() {
        let spec = GovernedWorkspaceSpec {
            egress: EgressPolicy::AllowedHosts(vec!["api.example.com".to_string()]),
            credentials: Vec::new(),
        };
        let expected = vpn_network_policy(&spec);
        let ready = |policy: &Value| json!({"status": "ok", "enforcementMode": "dns+nft", "policy": policy});
        assert!(verify_policy(&ready(&expected), &expected).is_ok());
        // Egress that comes back without the metadata denies must be refused.
        assert!(verify_policy(&ready(&spec.network_policy()), &expected).is_err());
    }
    #[test]
    fn image_versions_are_required_and_options_rejected() {
        assert!(validate_image("tailscale/tailscale:v1.80.3").is_ok());
        for invalid in [
            "tailscale/tailscale",
            "tailscale/tailscale:latest",
            "--privileged",
            "image:1;echo",
        ] {
            assert!(validate_image(invalid).is_err());
        }
    }
    #[test]
    fn capability_readback_accepts_docker_normalized_names_only_for_the_same_set() {
        let lease = Lease {
            schema_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            expires_at_unix_seconds: 123,
        };
        let container = |caps: Value| {
            json!({
                "Name": format!("/{}", lease.name("egress")),
                "Config": {"Labels": {(OWNER): lease.id, (ROLE): "egress", (DEADLINE): "123"}},
                "State": {"Running": true},
                "HostConfig": {
                    "NetworkMode": "net", "Privileged": false, "PidMode": "",
                    "CapDrop": ["ALL"], "CapAdd": caps,
                    "SecurityOpt": ["no-new-privileges"]
                },
                "Mounts": []
            })
        };
        for caps in [
            json!(["NET_ADMIN", "SETUID", "SETGID"]),
            json!(["CAP_NET_ADMIN", "CAP_SETUID", "CAP_SETGID"]),
        ] {
            assert!(
                verify_container(&container(caps), &lease, "egress", "net", None, false).is_ok()
            );
        }
        for caps in [
            json!(["CAP_NET_ADMIN", "CAP_SETUID", "CAP_SETGID", "CAP_SYS_ADMIN"]),
            json!(["CAP_NET_ADMIN", "CAP_SETUID"]),
        ] {
            assert!(
                verify_container(&container(caps), &lease, "egress", "net", None, false).is_err()
            );
        }
    }
    #[test]
    fn egress_environment_readback_requires_every_creation_value() {
        let upstream = "http://10.0.0.2:1055";
        let token = "token-1";
        let rules = r#"{"defaultAction":"deny","egress":[]}"#;
        let expected = || {
            vec![
                format!("{TOKEN_ENV}={token}"),
                "OPENSANDBOX_EGRESS_MODE=dns+nft".to_string(),
                "OPENSANDBOX_EGRESS_MITMPROXY_TRANSPARENT=true".to_string(),
                "OPENSANDBOX_EGRESS_BLOCK_DOH_443=true".to_string(),
                format!("OPENSANDBOX_EGRESS_RULES={rules}"),
                format!("OPENSANDBOX_EGRESS_UPSTREAM_PROXY={upstream}"),
                "PATH=/usr/bin".to_string(),
            ]
        };
        let verify = |env: Vec<String>| {
            verify_egress_environment(&json!({"Config": {"Env": env}}), upstream, token, rules)
        };
        assert!(verify(expected()).is_ok());

        for key in [
            "OPENSANDBOX_EGRESS_BLOCK_DOH_443=",
            "OPENSANDBOX_EGRESS_RULES=",
        ] {
            // Missing entirely.
            let mut missing = expected();
            missing.retain(|entry| !entry.starts_with(key));
            assert!(verify(missing).is_err(), "{key} absent must fail closed");
            // Present with a different value.
            let mut altered = expected();
            for entry in &mut altered {
                if entry.starts_with(key) {
                    *entry = format!("{key}false");
                }
            }
            assert!(verify(altered).is_err(), "{key} altered must fail closed");
            // Duplicated with a conflicting value.
            let mut duplicated = expected();
            duplicated.push(format!("{key}false"));
            assert!(
                verify(duplicated).is_err(),
                "{key} duplicated must fail closed"
            );
        }

        let mut wider_rules = expected();
        for entry in &mut wider_rules {
            if entry.starts_with("OPENSANDBOX_EGRESS_RULES=") {
                *entry = r#"OPENSANDBOX_EGRESS_RULES={"defaultAction":"allow","egress":[]}"#.into();
            }
        }
        assert!(verify(wider_rules).is_err());

        let mut insecure = expected();
        insecure.push("OPENSANDBOX_EGRESS_MITMPROXY_SSL_INSECURE=true".into());
        assert!(verify(insecure).is_err());
        assert!(verify_egress_environment(&json!({"Config": {}}), upstream, token, rules).is_err());
        assert!(verify_egress_environment(
            &json!({"Config": {"Env": [1]}}),
            upstream,
            token,
            rules
        )
        .is_err());
    }
    #[test]
    fn leased_names_cannot_be_container_ids_or_paths() {
        let lease = Lease {
            schema_version: 1,
            id: "../../foreign".into(),
            expires_at_unix_seconds: 10,
        };
        assert!(lease.validate().is_err());
    }
    #[test]
    fn cleanup_requires_exact_owner_role_and_deadline() {
        let lease = Lease {
            schema_version: 1,
            id: uuid::Uuid::new_v4().to_string(),
            expires_at_unix_seconds: 123,
        };
        assert!(verify_labels(
            &json!({(OWNER):lease.id,(ROLE):"workload",(DEADLINE):"123"}),
            &lease,
            "workload"
        )
        .is_ok());
        assert!(verify_labels(
            &json!({(OWNER):lease.id,(ROLE):"egress",(DEADLINE):"123"}),
            &lease,
            "workload"
        )
        .is_err());
    }
}
