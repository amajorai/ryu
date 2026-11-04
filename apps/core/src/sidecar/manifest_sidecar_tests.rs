use super::*;
use crate::plugin_manifest::schema::ExternalRuntimeConfig;
use crate::plugin_manifest::PluginTier;

fn egress_request_env() -> BTreeMap<String, String> {
    BTreeMap::from([
        ("KEEP".to_owned(), "1".to_owned()),
        (
            crate::local_egress::BROWSER_PROXY_ENV.to_owned(),
            EGRESS_PROXY_URL_REQUEST.to_owned(),
        ),
    ])
}

fn compiled_browser_manifest() -> crate::plugin_manifest::PluginManifest {
    crate::plugin_manifest::PluginManifestLoader::load_install_catalog()
        .into_iter()
        .find(|manifest| manifest.id == "@ryu/browser")
        .expect("compiled Browser manifest")
}

/// The Browser's Local sidecar (the one that declares the egress request),
/// selected by process kind so a reordered `sidecars` list cannot quietly
/// hand these tests a different spec.
fn browser_local_sidecar(manifest: &crate::plugin_manifest::PluginManifest) -> SidecarSpec {
    manifest
        .sidecars
        .iter()
        .find(|spec| matches!(spec.process, SidecarProcess::Local(_)))
        .cloned()
        .expect("Browser Local sidecar")
}

fn binary_spec() -> SidecarSpec {
    SidecarSpec {
        name: "engine".to_owned(),
        process: SidecarProcess::Binary(BinarySpec {
            url: "https://example.com/dl/my-engine".to_owned(),
            sha256: None,
            version: "1.2.3".to_owned(),
            archive: None,
            binary_name: None,
            args: vec!["--port".to_owned(), "9099".to_owned()],
            env: BTreeMap::new(),
        }),
        port: 9099,
        health_path: "/health".to_owned(),
        http: None,
        host_api: None,
        lazy: false,
        idle_stop_secs: None,
        provides_provider: None,
        sandbox: None,
    }
}

/// The `models.json` row for `id`, read straight off disk — the persisted form Pi
/// actually loads, not an in-memory projection of it.
fn provider_row(id: &str) -> Option<serde_json::Value> {
    let raw = std::fs::read_to_string(crate::pi_config::config_dir().join("models.json")).ok()?;
    let json: serde_json::Value = serde_json::from_str(&raw).ok()?;
    json.get("providers")?.get(id).cloned()
}

fn tmp_plugin_dir() -> PathBuf {
    let dir = std::env::temp_dir().join(format!("ryu-node-test-{}", uuid::Uuid::new_v4()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn manifest_with_backend(code: &str, sha: Option<&str>) -> crate::plugin_manifest::PluginManifest {
    crate::plugin_manifest::PluginManifest {
        id: "com.test.node".to_owned(),
        name: "Node".to_owned(),
        version: "1.0.0".to_owned(),
        backend_code: Some(code.to_owned()),
        backend_sha256: sha.map(str::to_owned),
        ..Default::default()
    }
}

// ── Missing app-sidecar binary: recorded + surfaced, never swallowed ──────────

/// A `Local` sidecar spec for a command that cannot exist on any host.
fn local_spec(command: &str) -> SidecarSpec {
    SidecarSpec {
        name: "worker".to_owned(),
        process: SidecarProcess::Local(crate::plugin_manifest::schema::LocalProcessSpec {
            command: command.to_owned(),
            command_env: None,
            port_env: None,
            args: vec![],
            env: BTreeMap::new(),
            bundles: BTreeMap::new(),
        }),
        port: 9098,
        health_path: "/health".to_owned(),
        http: None,
        host_api: None,
        lazy: false,
        idle_stop_secs: None,
        provides_provider: None,
        sandbox: None,
    }
}

// ── the managed-bin ready notifier ────────────────────────────────────────────

/// A uniquely-named slot in the Ryu-managed bin dir: reserved (absent) first, so a
/// test can assert the enable-time skip, then `install()`ed to make the binary land.
/// Removed on `Drop`.
///
/// Writes into the process's ACTUAL data dir (`~/.ryu/bin`, or the profile variant)
/// rather than redirecting it: `paths::ryu_dir()` is a `OnceLock` resolved on first
/// use, so setting `RYU_DIR` from a test would take effect or not depending on which
/// sibling test ran first. A uuid-suffixed name cannot collide with a real installed
/// binary, and it is never spawned.
struct ManagedBinSlot {
    command: String,
    path: PathBuf,
}

impl ManagedBinSlot {
    fn reserve() -> Self {
        let command = format!("ryu-test-notify-{}", uuid::Uuid::new_v4());
        let path = managed_bin_path(&command);
        assert!(
            which_on_path(&command).is_none(),
            "precondition: a uuid-named command is not on PATH"
        );
        assert!(!path.is_file(), "precondition: the slot starts empty");
        Self { command, path }
    }

    /// The binary lands — deliberately WITHOUT the `<command>.version` marker
    /// `ensure_local_sidecar_present` demands before it reuses a bin. The marker is
    /// download-lifecycle policy; the MCP resolver rung only asks "is there a file
    /// here", so this is also the dev-box shape (a locally built binary).
    fn install(&self) {
        std::fs::create_dir_all(self.path.parent().expect("bin dir has a parent"))
            .expect("create the managed bin dir");
        std::fs::write(&self.path, b"").expect("write the managed bin");
    }
}

impl Drop for ManagedBinSlot {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.path);
    }
}

/// A manifest declaring exactly one `mcp_servers` entry whose `command` is the bare
/// name of a Ryu-managed binary — the shape the managed-bin resolver rung exists for
/// (no `command_env` for anything to seed).
fn manifest_declaring_mcp_server(
    plugin_id: &str,
    server: &str,
    command: &str,
) -> crate::plugin_manifest::PluginManifest {
    let mut mcp_servers = BTreeMap::new();
    mcp_servers.insert(
        server.to_owned(),
        crate::plugin_manifest::McpServerDecl {
            command: Some(command.to_owned()),
            command_env: None,
            args: vec![],
            env: BTreeMap::new(),
            description: None,
            enabled: true,
            ..Default::default()
        },
    );
    crate::plugin_manifest::PluginManifest {
        id: plugin_id.to_owned(),
        name: "Notifier Test".to_owned(),
        version: "1.0.0".to_owned(),
        mcp_servers,
        ..Default::default()
    }
}

// ── The ext-API fetch hook ────────────────────────────────────────────────

/// A one-shot loopback server that counts connections and answers every request
/// with a bare 404 — the shape of a real sidecar that serves no OpenAPI document,
/// which is the case the latch has to terminate on. Returns its port plus the
/// live hit counter.
///
/// A real socket rather than a mock because the thing under test is precisely
/// whether a SECOND fetch happens: a fake that records calls to a trait would be
/// asserting about the fake's own bookkeeping, not about the hook's behaviour.
fn spawn_counting_probe() -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
    spawn_probe(ProbeReply::Status(404))
}

/// What a [`spawn_probe`] listener answers with. Each variant is a classification
/// the fetch hook has to get right, and each one is a different code path out of
/// `import_openapi` — which is why they share one listener instead of three.
#[derive(Clone, Copy)]
enum ProbeReply {
    /// A bare status with an empty body (404 ⇒ definitive, 503 ⇒ transient).
    Status(u16),
    /// A 200 whose body is `bytes` long — used to cross
    /// [`EXT_API_SPEC_MAX_BYTES`]. The declared `content-length` is deliberately a
    /// LIE (it claims a small body), so passing this test proves the *streaming*
    /// total is what bounds the read, not the header pre-check a hostile or buggy
    /// server controls.
    OversizedBody { bytes: usize },
}

/// A loopback server that counts connections and answers every request the same
/// way. Returns its port plus the live hit counter.
fn spawn_probe(reply: ProbeReply) -> (u16, Arc<std::sync::atomic::AtomicUsize>) {
    use std::sync::atomic::AtomicUsize;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind loopback");
    let port = listener.local_addr().expect("addr").port();
    listener.set_nonblocking(true).expect("nonblocking");
    let hits = Arc::new(AtomicUsize::new(0));
    let counter = Arc::clone(&hits);
    if let ProbeReply::OversizedBody { bytes } = reply {
        tokio::spawn(async move {
            let listener = tokio::net::TcpListener::from_std(listener).expect("into tokio");
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                counter.fetch_add(1, Ordering::SeqCst);
                let mut buf = [0u8; 2048];
                let _ = sock.read(&mut buf).await;
                // Chunked, so the client cannot pre-empt on `content-length` — the
                // read has to be stopped by the running total or not at all.
                let _ = sock
                    .write_all(
                        b"HTTP/1.1 200 OK\r\ncontent-type: application/json\r\n\
                              transfer-encoding: chunked\r\nconnection: close\r\n\r\n",
                    )
                    .await;
                // 64 KB of filler per chunk; the JSON is never valid, which is fine
                // — the cap must trip long before anything tries to parse it.
                let chunk = vec![b'x'; 64 * 1024];
                let header = format!("{:x}\r\n", chunk.len());
                let mut sent = 0usize;
                while sent < bytes {
                    if sock.write_all(header.as_bytes()).await.is_err()
                        || sock.write_all(&chunk).await.is_err()
                        || sock.write_all(b"\r\n").await.is_err()
                    {
                        break;
                    }
                    sent += chunk.len();
                }
                let _ = sock.write_all(b"0\r\n\r\n").await;
                let _ = sock.shutdown().await;
            }
        });
        return (port, hits);
    }
    let ProbeReply::Status(status) = reply else {
        unreachable!("the oversized arm returned above");
    };
    tokio::spawn(async move {
        let listener = tokio::net::TcpListener::from_std(listener).expect("into tokio");
        loop {
            let Ok((mut sock, _)) = listener.accept().await else {
                return;
            };
            counter.fetch_add(1, Ordering::SeqCst);
            // Drain the request line/headers first: answering into an unread
            // socket makes some clients report a connection reset instead of the
            // status, which would misclassify a definitive 404 as transient.
            let mut buf = [0u8; 2048];
            let _ = sock.read(&mut buf).await;
            let resp = format!(
                "HTTP/1.1 {status} Status\r\ncontent-length: 0\r\nconnection: close\r\n\r\n"
            );
            let _ = sock.write_all(resp.as_bytes()).await;
            let _ = sock.shutdown().await;
        }
    });
    (port, hits)
}

/// The default hook fixture: plugin `@ryu/probe`, its `worker` sidecar, no live
/// manifest store (so [`OpenApiImport::lowering_inputs`] falls back to the
/// snapshot, which is the shape every pre-existing test asserts against).
fn probe_import(registry: &Arc<crate::sidecar::mcp::McpRegistry>) -> OpenApiImport {
    probe_import_named(registry, "@ryu/probe", "worker")
}

fn probe_import_named(
    registry: &Arc<crate::sidecar::mcp::McpRegistry>,
    plugin_id: &str,
    sidecar: &str,
) -> OpenApiImport {
    OpenApiImport {
        registry: Arc::clone(registry),
        plugin_id: plugin_id.to_owned(),
        sidecar_name: sidecar.to_owned(),
        sidecar_key: namespaced_name(plugin_id, sidecar),
        manifests: None,
        upstream_mount: "/api".to_owned(),
        declared_routes: Vec::new(),
        client: reqwest::Client::new(),
        runtime: None,
    }
}

/// One derived row, shaped enough to be stored and counted. The registry never
/// inspects anything but `id`/`plugin_id` on the paths under test here.
fn derived_row(id: &str, plugin: &str) -> crate::ext_api::ExtApiRoute {
    crate::ext_api::ExtApiRoute {
        id: id.to_owned(),
        plugin_id: plugin.to_owned(),
        method: "GET".to_owned(),
        url: format!("core:/api/ext/{plugin}/thing"),
        name: "Do the thing".to_owned(),
        description: None,
        header_params: vec![],
        input_schema: serde_json::json!({ "type": "object", "properties": {} }),
    }
}

#[path = "manifest_sidecar_tests/deactivate_clears_test.rs"]
mod deactivate_clears;
#[path = "manifest_sidecar_tests/import_definitive_test.rs"]
mod import_definitive;
#[path = "manifest_sidecar_tests/node_provider_test.rs"]
mod node_provider;
#[path = "manifest_sidecar_tests/sidecar_egress_test.rs"]
mod sidecar_egress;
#[path = "manifest_sidecar_tests/sidecar_local_test.rs"]
mod sidecar_local;
