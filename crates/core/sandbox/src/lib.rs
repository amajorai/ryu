//! Core Sandbox trait: ephemeral exec and long-lived workspace abstraction.
//!
//! Backend implementations live in sub-modules:
//! - [`wasmtime`] — wasmtime/WASI in-process ephemeral exec (M6 default)
//! - [`docker`] — Docker/OCI containers via the `docker` CLI (detect-only)
//! - [`microsandbox`] — microVMs via the `msb` CLI (detect-only)
//! - [`opensandbox`] — gVisor/Kata/Firecracker via the `osb` CLI (detect-only)
//! - [`daytona`] — remote sandboxes via the Daytona REST API (token-gated)
//! - [`local`] — host subprocess in a temp dir; **no isolation**, explicit opt-in
//! - [`ssh`] — remote host via the system `ssh` client (config-gated)
//! - [`singularity`] — Apptainer/Singularity containers via the host CLI (detect-only)
//! - [`box_backend`] — durable Box service over its public REST API
//!
//! Sandboxing is "what runs" (an execution context), so this lives in Core per
//! the Core-vs-Gateway rule (CLAUDE.md §1). Policy over *what is allowed* inside
//! a sandbox (DLP, network egress, budget) remains in Gateway; Core only decides
//! which backend to spawn and what spec to hand it.
//!
//! Two shapes are expressed by the trait:
//! - **Ephemeral exec** — one command, capture stdout/stderr, auto-teardown.
//! - **Long-lived workspace** — create a persistent context, exec multiple
//!   commands inside it, then destroy it.
//!
//! Both shapes carry a [`SandboxCapabilities`] descriptor that defaults to
//! deny-all (no FS paths, no network). The backend must enforce these; Core
//! does not re-check them after construction.
//!
//! Backends register through [`SandboxBackend`] and are selected by name via
//! [`select_backend`]. The only hard rule: `select_backend` never returns an
//! unknown backend silently — it errors out so callers can surface the problem.

mod capture;
pub use capture::WorkspaceCleanup;
pub mod box_backend;
pub mod box_credential;
pub mod box_session;
pub mod box_types;
pub mod daytona;
pub mod docker;
pub mod governed;
pub mod governed_vpn;
pub mod heartbeat;
pub mod host;
pub mod local;
pub mod microsandbox;
pub mod mxc;
pub mod opensandbox;
pub mod os_isolation;
mod process_output;
pub mod session;
pub mod singularity;
pub mod spec;
pub mod ssh;
#[cfg(test)]
mod test_http;
pub mod wasmtime;
pub mod win_process;

use std::collections::HashSet;
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

/// Boxed, `Send` future alias for the async trait methods (mirrors the Core
/// `sidecar::BoxFuture` this crate was extracted from — kept local so the crate
/// has no `apps/core` dependency).
pub type BoxFuture<T> = Pin<Box<dyn Future<Output = T> + Send>>;

// ── Scope + workspace access ─────────────────────────────────────────────────

/// How long a sandbox context lives and how widely it is shared.
///
/// Ryu's built-in sandboxes (wasmtime, the JS sandbox) are historically **per-exec**:
/// each call spins up a fresh context that is torn down the moment the command
/// exits. `SandboxScope` lets an agent *declare* a broader lifetime so a future
/// scheduler can reuse one context across calls (mirroring OpenClaw's
/// per-session / per-agent / shared scoping).
///
/// This is declarative metadata only: the default [`SandboxScope::Exec`] is
/// exactly today's behavior, and the wider variants have no runtime effect
/// until a backend chooses to honor them. Declaring a wider scope never
/// loosens isolation on its own.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum SandboxScope {
    /// One context per exec call, torn down immediately. The current default.
    #[default]
    Exec,
    /// One context reused across every call from the same agent.
    Agent,
    /// One context reused across every call in the same session.
    Session,
    /// One context shared node-wide across all agents and sessions.
    Shared,
}

impl SandboxScope {
    /// Parse a scope name string into the enum, erroring on unknown names.
    pub fn from_name(name: &str) -> Result<Self> {
        match name.trim() {
            "exec" => Ok(Self::Exec),
            "agent" => Ok(Self::Agent),
            "session" => Ok(Self::Session),
            "shared" => Ok(Self::Shared),
            other => Err(anyhow!("unknown sandbox scope '{other}'")),
        }
    }

    /// Canonical string name for this scope.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Exec => "exec",
            Self::Agent => "agent",
            Self::Session => "session",
            Self::Shared => "shared",
        }
    }
}

/// Level of access a sandbox has to its mounted workspace filesystem.
///
/// This clamps the FS mounts derived from [`SandboxCapabilities::fs_read_paths`]
/// and [`SandboxCapabilities::fs_write_paths`]. It can only *tighten* access,
/// never expand it: a path that is not in the capability sets is never mounted
/// regardless of the level.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, Default)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceAccess {
    /// No workspace FS access: every mount is stripped, regardless of the
    /// capability path sets.
    None,
    /// Read-only: every mounted path is clamped to read, even paths that also
    /// appear in `fs_write_paths`.
    ReadOnly,
    /// Read + write: the `fs_read_paths` / `fs_write_paths` sets define access
    /// exactly. This is the historical default and preserves today's per-exec
    /// behavior; tighter levels only remove access.
    #[default]
    ReadWrite,
}

impl WorkspaceAccess {
    /// Parse a workspace-access name string into the enum, erroring on unknown
    /// names. Accepts both `read_only`/`read-only` spellings for ergonomics.
    pub fn from_name(name: &str) -> Result<Self> {
        match name.trim() {
            "none" => Ok(Self::None),
            "read_only" | "read-only" | "ro" => Ok(Self::ReadOnly),
            "read_write" | "read-write" | "rw" => Ok(Self::ReadWrite),
            other => Err(anyhow!("unknown workspace access '{other}'")),
        }
    }

    /// Canonical string name for this access level.
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::None => "none",
            Self::ReadOnly => "read_only",
            Self::ReadWrite => "read_write",
        }
    }
}

// ── Capability descriptor ────────────────────────────────────────────────────

/// Capabilities granted to a sandbox execution.
///
/// Defaults to **deny-all**: no FS access, no network. Callers must explicitly
/// opt in to each permission they need — the zero value is safe by definition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxCapabilities {
    /// Filesystem paths the sandbox may read from. Empty = no FS read access.
    pub fs_read_paths: HashSet<PathBuf>,
    /// Filesystem paths the sandbox may write to. Empty = no FS write access.
    pub fs_write_paths: HashSet<PathBuf>,
    /// Whether outbound network access is permitted.
    pub network: bool,
    /// Declared lifetime/sharing scope for this sandbox context. Default
    /// [`SandboxScope::Exec`] = one context per exec (today's behavior).
    pub scope: SandboxScope,
    /// Access level applied to the mounted workspace filesystem. Default
    /// [`WorkspaceAccess::ReadWrite`] honors the FS path sets exactly (today's
    /// behavior); [`WorkspaceAccess::ReadOnly`] clamps mounts to read and
    /// [`WorkspaceAccess::None`] strips them entirely.
    pub workspace_access: WorkspaceAccess,
}

impl Default for SandboxCapabilities {
    /// Returns the deny-all default: no FS paths, no network, per-exec scope,
    /// and the passthrough [`WorkspaceAccess::ReadWrite`] level (which is a
    /// no-op ceiling over the empty path sets).
    fn default() -> Self {
        Self {
            fs_read_paths: HashSet::new(),
            fs_write_paths: HashSet::new(),
            network: false,
            scope: SandboxScope::Exec,
            workspace_access: WorkspaceAccess::ReadWrite,
        }
    }
}

impl SandboxCapabilities {
    /// Lower a manifest-declared [`PermissionSet`] into the sandbox capability
    /// descriptor the wasmtime/Docker backends enforce.
    ///
    /// This is the wasmtime/Docker arm of the unified permission grammar (the JS
    /// sandbox arm lives in `ryu-tool-exec`, which takes the same [`PermissionSet`],
    /// refuses filesystem/network grants and maps `child_process` to its
    /// `childProcess.run` allow-list). The mapping:
    ///
    /// - `fs.read` / `fs.write` → [`Self::fs_read_paths`] / [`Self::fs_write_paths`]
    ///   (lowered by wasmtime to WASI preopens and by Docker to `--mount` flags).
    /// - `network` → [`Self::network`], a single boolean: **any** permitted network
    ///   (`true` or a non-empty host list) lowers to `true`. Host-scoped egress
    ///   (`network: ["h:443"]`) has no precise lowering here: the
    ///   WASI/Docker knob is all-or-nothing, so a host list opens the network broadly
    ///   here — tighten host-scoping at the Gateway egress layer, not the sandbox.
    /// - `child_process` / `tool` have **no** representation in a `SandboxCapabilities`
    ///   (a WASI module cannot fork; tools are stdio-brokered), so they are dropped —
    ///   the wasmtime/Docker sandbox is inherently subprocess-less.
    ///
    /// Scope + workspace-access stay at their deny-all-friendly defaults
    /// (per-exec / honor-the-path-sets); a manifest does not widen them.
    pub fn from_permissions(permissions: &ryu_kernel_contracts::manifest::PermissionSet) -> Self {
        Self {
            fs_read_paths: permissions.fs.read.iter().map(PathBuf::from).collect(),
            fs_write_paths: permissions.fs.write.iter().map(PathBuf::from).collect(),
            network: permissions.network.is_allowed(),
            scope: SandboxScope::Exec,
            workspace_access: WorkspaceAccess::ReadWrite,
        }
    }

    /// Return the effective mount set after applying [`Self::workspace_access`],
    /// as `(path, writable)` pairs. Shared by the FS-touching backends so the
    /// three-way clamp semantics stay identical across wasmtime and docker:
    ///
    /// - [`WorkspaceAccess::None`] → empty (no mounts at all).
    /// - [`WorkspaceAccess::ReadOnly`] → every path, `writable = false`.
    /// - [`WorkspaceAccess::ReadWrite`] → union of both sets, `writable` true
    ///   only for paths in `fs_write_paths` (the historical per-path logic).
    pub fn effective_mounts(&self) -> Vec<(PathBuf, bool)> {
        if self.workspace_access == WorkspaceAccess::None {
            return Vec::new();
        }
        let allow_write = self.workspace_access == WorkspaceAccess::ReadWrite;
        let mut mounts: std::collections::HashMap<PathBuf, bool> = std::collections::HashMap::new();
        for path in &self.fs_read_paths {
            mounts.entry(path.clone()).or_insert(false);
        }
        for path in &self.fs_write_paths {
            // Write set wins under ReadWrite; ReadOnly forces every mount to ro.
            mounts.insert(path.clone(), allow_write);
        }
        mounts.into_iter().collect()
    }
}

// ── Ephemeral exec spec ──────────────────────────────────────────────────────

/// Specification for a single ephemeral command execution.
#[derive(Debug, Clone)]
pub struct ExecSpec {
    /// The command to run (argv[0]).
    pub command: String,
    /// Arguments passed to the command.
    pub args: Vec<String>,
    /// Capabilities granted for this execution. Defaults to deny-all.
    pub capabilities: SandboxCapabilities,
    /// Optional stdin bytes piped to the command.
    pub stdin: Option<Vec<u8>>,
    /// Environment variables exposed to the workload, as `(key, value)` pairs.
    /// Only the wasmtime backend honors these (as the guest's WASI
    /// environment); the process backends start from a cleared environment
    /// and ignore this field.
    pub env: Vec<(String, String)>,
    /// Host commands accept 1–300 seconds. Local/SSH default to 120 seconds;
    /// Docker, microsandbox and OpenSandbox default to 30 seconds.
    pub timeout_secs: Option<u64>,
}

impl ExecSpec {
    /// Construct with deny-all capabilities.
    pub fn new(command: impl Into<String>, args: Vec<String>) -> Self {
        Self {
            command: command.into(),
            args,
            capabilities: SandboxCapabilities::default(),
            stdin: None,
            env: Vec::new(),
            timeout_secs: None,
        }
    }
}

/// Output captured from a completed ephemeral execution.
#[derive(Debug, Clone)]
pub struct ExecOutput {
    /// Process exit code (0 = success).
    pub exit_code: i32,
    /// Raw bytes written to stdout.
    pub stdout: Vec<u8>,
    /// Raw bytes written to stderr.
    pub stderr: Vec<u8>,
}

// ── Workspace handle ─────────────────────────────────────────────────────────

/// An opaque identifier for a long-lived workspace created by a backend.
#[derive(Debug, Clone, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(transparent)]
pub struct WorkspaceId(pub String);

// ── Sandbox trait ────────────────────────────────────────────────────────────

/// Contract implemented by every sandbox backend.
///
/// Mirrors the Core `Sidecar` trait style: all async methods
/// return [`BoxFuture`] so they compose uniformly with the rest of the sidecar
/// machinery without requiring `async_trait`.
pub trait Sandbox: Send + Sync {
    /// Unique backend name (e.g. `"wasmtime"`, `"docker"`, `"subprocess"`).
    fn name(&self) -> &'static str;

    // ── Ephemeral path ──────────────────────────────────────────────────────

    /// Run `spec` in an isolated context, capture output, and tear down.
    ///
    /// The backend must:
    /// 1. Enforce `spec.capabilities` (deny-all when fields are empty/false).
    /// 2. Apply `spec.timeout_secs` if set.
    /// 3. Return [`ExecOutput`] on success; propagate errors via `Err`.
    fn exec(&self, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>>;

    // ── Long-lived workspace path ───────────────────────────────────────────

    /// Create a persistent workspace and return its opaque ID.
    ///
    /// The workspace lives until [`Sandbox::destroy`] is called. Callers are
    /// responsible for cleanup — leaked workspaces are a resource leak.
    fn create_workspace(&self, capabilities: SandboxCapabilities)
        -> BoxFuture<Result<WorkspaceId>>;

    /// Execute `spec` inside an existing workspace.
    ///
    /// The workspace's capabilities were set at creation time; `spec.capabilities`
    /// may further restrict (but not expand) them. Backends are free to ignore
    /// the per-exec capabilities field if they cannot express the intersection.
    fn exec_in_workspace(&self, id: &WorkspaceId, spec: ExecSpec) -> BoxFuture<Result<ExecOutput>>;

    /// Destroy a workspace and release all its resources.
    fn destroy_workspace(&self, id: &WorkspaceId) -> BoxFuture<Result<()>>;
}

// ── Backend registry / enum ──────────────────────────────────────────────────

/// Named backends available in Core.
///
/// Variants are added here as backends land. The registry never silently falls
/// back to an unknown backend — `select_backend` returns an error instead so
/// callers surface the misconfiguration.
///
/// There is deliberately NO `Subprocess` variant. A "spawn the command on the
/// host with a restricted environment" backend has no isolation boundary at all,
/// which contradicts this module's default-deny posture
/// ([`SandboxCapabilities::default`] denies FS and network), and every real need
/// is already covered: `wasmtime` (built-in, no daemon), `docker`,
/// `microsandbox`, `opensandbox`, `daytona`. The variant used to exist and
/// `build_command_backend` always returned "not implemented yet" for it, so
/// `RYU_SANDBOX_BACKEND=subprocess` silently disabled every sandboxed exec on the
/// node. `"subprocess"` is not in the vocabulary and is rejected as an honest
/// `unknown sandbox backend` error, like any other unrecognised name.
///
/// [`SandboxBackend::Local`] is the honest successor for the rare operator who
/// really wants host execution: it reports `isolation: none`, refuses to run
/// until `RYU_SANDBOX_LOCAL_ENABLE=1` is set, and is never a default or fallback.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SandboxBackend {
    /// wasmtime backend: run a WASM/WASI module with strict capability limits.
    /// The default secure backend when available.
    Wasmtime,
    /// Docker/OCI backend: run a container image. Opt-in; requires Docker daemon.
    Docker,
    /// Host subprocess in a fresh temp dir. Running directly on the host is
    /// not an isolation boundary, so it requires an explicit operator opt-in
    /// (`RYU_SANDBOX_LOCAL_ENABLE=1`) and never becomes an implicit fallback.
    Local,
    /// Remote host over the system `ssh` client (`RYU_SANDBOX_SSH_HOST`, …).
    Ssh,
    /// Modal remote provider vocabulary. Not implemented in Core; see
    /// [`unimplemented_backend_hint`].
    Modal,
    /// Vercel Sandbox remote provider vocabulary. Not implemented in Core; see
    /// [`unimplemented_backend_hint`].
    VercelSandbox,
    /// Apptainer/Singularity containers via the host `apptainer`/`singularity` CLI.
    Singularity,
    /// Daytona remote sandbox backend.
    Daytona,
    /// Ryu Box durable workspace service.
    Box,
    /// microVM backend.
    Microsandbox,
    /// OpenSandbox backend.
    Opensandbox,
    /// Microsoft eXecution Container (MXC) Windows process container.
    Mxc,
    /// Custom backend identified by name.
    Custom(String),
}

impl SandboxBackend {
    /// Parse a backend name string into the enum.
    pub fn from_name(name: &str) -> Result<Self> {
        match name {
            "wasmtime" => Ok(Self::Wasmtime),
            "docker" => Ok(Self::Docker),
            "local" => Ok(Self::Local),
            "ssh" => Ok(Self::Ssh),
            "modal" => Ok(Self::Modal),
            "vercel_sandbox" => Ok(Self::VercelSandbox),
            "singularity" => Ok(Self::Singularity),
            "daytona" => Ok(Self::Daytona),
            "box" => Ok(Self::Box),
            "microsandbox" => Ok(Self::Microsandbox),
            "opensandbox" => Ok(Self::Opensandbox),
            "mxc" => Ok(Self::Mxc),
            "" => Err(anyhow!("sandbox backend name must not be empty")),
            other => Err(anyhow!("unknown sandbox backend '{other}'")),
        }
    }

    /// Canonical string name for this backend.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Wasmtime => "wasmtime",
            Self::Docker => "docker",
            Self::Local => "local",
            Self::Ssh => "ssh",
            Self::Modal => "modal",
            Self::VercelSandbox => "vercel_sandbox",
            Self::Singularity => "singularity",
            Self::Daytona => "daytona",
            Self::Box => "box",
            Self::Microsandbox => "microsandbox",
            Self::Opensandbox => "opensandbox",
            Self::Mxc => "mxc",
            Self::Custom(name) => name.as_str(),
        }
    }
}

/// Select the most suitable available backend, given a preferred name.
///
/// - If `preferred` is `Some`, parse and return it. An unrecognised name is an
///   error, so a typo surfaces immediately and never becomes a silent swap.
/// - If `preferred` is `None`, return the platform default ([`default_backend`]).
///
/// This function never silently falls back from a *named* backend to another.
pub fn select_backend(preferred: Option<&str>) -> Result<SandboxBackend> {
    match preferred {
        Some(name) => SandboxBackend::from_name(name),
        None => Ok(default_backend()),
    }
}

/// The default backend: `wasmtime`. It is the only backend built INTO Core (no
/// daemon, no external CLI), so it is the one default that always resolves.
///
/// There is no lower-isolation fallback below it by design — degrading to a
/// weaker sandbox on a machine where the strong one is missing would silently
/// downgrade the security posture. If wasmtime is not compiled in, construction
/// fails loudly and the operator picks a backend explicitly (the swappable
/// default is the config knob, not a hidden fallback chain).
pub fn default_backend() -> SandboxBackend {
    SandboxBackend::Wasmtime
}

/// Env var that overrides the default sandbox backend node-wide.
///
/// Accepts any name [`SandboxBackend::from_name`] understands (`wasmtime`,
/// `docker`, `microsandbox`, `opensandbox`, …). Empty/unset keeps the
/// [`default_backend`] (wasmtime). A per-call `backend` argument always wins
/// over this node default.
pub const ENV_SANDBOX_BACKEND: &str = "RYU_SANDBOX_BACKEND";

/// The node's configured default backend. Resolution order:
/// 1. the persisted picker selection ([`SandboxBackendStore`], written by
///    `POST /api/sandbox/backend`);
/// 2. the `RYU_SANDBOX_BACKEND` env override;
/// 3. [`default_backend`] (wasmtime).
///
/// Never errors — a bad/empty value at any layer falls through to the next, since
/// this is a "swappable default, never a lock" knob (CLAUDE.md §1).
pub fn configured_backend() -> SandboxBackend {
    if let Some(name) = SandboxBackendStore::load()
        .default
        .filter(|s| !s.trim().is_empty())
    {
        if let Ok(backend) = SandboxBackend::from_name(name.trim()) {
            return backend;
        }
    }
    std::env::var(ENV_SANDBOX_BACKEND)
        .ok()
        .filter(|s| !s.trim().is_empty())
        .and_then(|s| SandboxBackend::from_name(s.trim()).ok())
        .unwrap_or_else(default_backend)
}

/// The sandbox backends Ryu knows how to select, in display order. `wasmtime` is
/// the built-in default; the rest are detect-gated swaps (external CLIs, remote
/// services, opt-in host execution) or recognised-but-unimplemented vocabulary.
pub const KNOWN_BACKENDS: &[&str] = &[
    "wasmtime",
    "docker",
    "local",
    "ssh",
    "modal",
    "vercel_sandbox",
    "singularity",
    "microsandbox",
    "opensandbox",
    "mxc",
    "daytona",
    "box",
];

/// Stable conformance vocabulary shared by Core, tools, and provider discovery.
/// `implemented` is a product/runtime contract, while `available` is filled by
/// [`discover_backends`] and is always a live node fact. No entry is a fallback.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct SandboxBackendDescriptor {
    pub name: String,
    pub implemented: bool,
    pub available: bool,
    pub remote: bool,
    pub persistence: String,
    pub isolation: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub diagnostic: Option<String>,
}

fn backend_conformance(name: &str) -> Option<(bool, bool, &'static str, &'static str)> {
    Some(match name {
        "wasmtime" => (
            true,
            false,
            "ephemeral; no persistent workspace",
            "WASI capability sandbox",
        ),
        "docker" => (
            true,
            false,
            "ephemeral by default; workspace lifecycle supported",
            "OCI container boundary",
        ),
        "local" => (
            true,
            false,
            "ephemeral temp dir by default; workspace lifecycle supported",
            "none; host execution as the Core user (explicit opt-in)",
        ),
        "ssh" => (
            true,
            true,
            "ephemeral remote temp dir by default; workspace lifecycle supported",
            "remote host user account; no Ryu sandbox boundary",
        ),
        "modal" => (
            false,
            true,
            "provider-defined remote persistence",
            "provider-defined remote isolation",
        ),
        "vercel_sandbox" => (
            false,
            true,
            "provider-defined remote persistence",
            "provider-defined remote isolation",
        ),
        "singularity" => (
            true,
            false,
            "ephemeral by default; workspace lifecycle via instances",
            "Apptainer/Singularity container (--containall; network none unless granted)",
        ),
        "daytona" => (
            true,
            true,
            "persistent workspaces; explicit destroy required",
            "remote provider sandbox",
        ),
        "box" => (
            true,
            true,
            "durable boxes; stop/resume/fork; explicit destroy",
            "remote service driver boundary",
        ),
        "microsandbox" => (
            true,
            false,
            "ephemeral by default; workspace lifecycle supported",
            "microVM boundary",
        ),
        "opensandbox" => (
            true,
            false,
            "ephemeral by default; workspace lifecycle supported",
            "gVisor/Kata/Firecracker boundary",
        ),
        "mxc" => (
            true,
            false,
            "ephemeral temp dir by default; workspace lifecycle supported",
            "Windows OS process container (AppContainer/BaseContainer)",
        ),
        _ => return None,
    })
}

/// Return the static descriptor for a known backend. This is the generic seam
/// plugin providers can project into later; Core does not branch on providers.
pub fn backend_descriptor(name: &str) -> Option<SandboxBackendDescriptor> {
    let (implemented, remote, persistence, isolation) = backend_conformance(name)?;
    Some(SandboxBackendDescriptor {
        name: name.to_owned(),
        implemented,
        available: false,
        remote,
        persistence: persistence.to_owned(),
        isolation: isolation.to_owned(),
        diagnostic: None,
    })
}

/// Discover all known backends in stable vocabulary order. Detection is
/// observational only: it never installs, provisions, or falls back.
pub async fn discover_backends() -> Vec<SandboxBackendDescriptor> {
    let mut discovered = Vec::with_capacity(KNOWN_BACKENDS.len());
    for name in KNOWN_BACKENDS {
        let mut descriptor = backend_descriptor(name).expect("KNOWN_BACKENDS has descriptors");
        descriptor.available = descriptor.implemented && detect_backend(name).await;
        if !descriptor.implemented {
            descriptor.diagnostic = Some(format!(
                "recognized but not implemented: {}",
                unimplemented_backend_hint(name)
            ));
        } else if !descriptor.available {
            descriptor.diagnostic = Some(format!("{name} is not available on this node"));
        }
        discovered.push(descriptor);
    }
    discovered
}

/// Human-facing label for a known backend (`name` for anything unknown).
pub fn backend_display_name(name: &str) -> &str {
    match name {
        "wasmtime" => "Wasmtime (WASM · built-in)",
        "docker" => "Docker",
        "local" => "Local host (no isolation)",
        "ssh" => "SSH (remote host)",
        "modal" => "Modal (provider)",
        "vercel_sandbox" => "Vercel Sandbox (provider)",
        "singularity" => "Apptainer / Singularity",
        "microsandbox" => "microsandbox",
        "opensandbox" => "OpenSandbox",
        "mxc" => "MXC (Windows process container)",
        "daytona" => "Daytona (remote)",
        "box" => "Ryu Box (persistent)",
        other => other,
    }
}

/// Whether `name` is actually runnable on this node *right now*. For wasmtime
/// this is a compile-time fact (the `sandbox-wasmtime` feature); for the
/// external CLIs it is a live probe of their binary (`docker version`, etc.).
///
/// Detection-only: never installs anything. Each external probe carries its
/// own short timeout, so this is safe to call from a request handler.
pub async fn detect_backend(name: &str) -> bool {
    match name {
        "wasmtime" => cfg!(feature = "sandbox-wasmtime"),
        "docker" => matches!(docker::detect().await, docker::DetectResult::Available),
        "microsandbox" => matches!(
            microsandbox::detect().await,
            microsandbox::DetectResult::Available
        ),
        "opensandbox" => matches!(
            opensandbox::detect().await,
            opensandbox::DetectResult::Available
        ),
        "mxc" => matches!(mxc::detect().await, mxc::DetectResult::Available),
        "daytona" => matches!(daytona::detect().await, daytona::DetectResult::Available),
        "local" => matches!(local::detect().await, local::DetectResult::Available),
        "ssh" => matches!(ssh::detect().await, ssh::DetectResult::Available),
        "box" => matches!(
            box_backend::detect().await,
            box_backend::DetectResult::Available
        ),
        "singularity" => matches!(
            singularity::detect().await,
            singularity::DetectResult::Available
        ),
        _ => false,
    }
}

/// Path of the persisted default-backend selection.
fn sandbox_backend_path() -> PathBuf {
    ryu_sidecar_runtime::layout::state_path(&crate::host::ryu_dir(), "sandbox-backend.json")
}

/// Durable record of the picker-selected default sandbox backend, persisted to
/// `<data dir>/state/sandbox-backend.json`. Mirrors `ActiveEngineStore`'s load/save shape.
/// Distinct from the engine swap: this is a *default*, not an exclusive resident
/// slot — a per-call `backend` argument always overrides it.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct SandboxBackendStore {
    /// Name of the selected default backend, or `None` to use the built-in
    /// wasmtime default.
    #[serde(default)]
    pub default: Option<String>,
}

impl SandboxBackendStore {
    /// Load the persisted selection, returning the default (none) when the file
    /// is missing or unreadable.
    pub fn load() -> Self {
        std::fs::read_to_string(sandbox_backend_path())
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    /// Persist `default` as the selected backend (None clears the selection).
    pub fn save(default: Option<&str>) -> Result<()> {
        let path = sandbox_backend_path();
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let store = Self {
            default: default.map(str::to_owned),
        };
        std::fs::write(&path, serde_json::to_string_pretty(&store)?)?;
        Ok(())
    }
}

/// Build a process/command sandbox backend (one that runs a `command` + `args`,
/// as opposed to the wasmtime backend, which runs a WASM module).
///
/// Returns `Err` for [`SandboxBackend::Wasmtime`] (use the wasmtime path with a
/// WASM module instead) and for unknown `Custom` names — including
/// `"subprocess"`, which is not a backend (see [`SandboxBackend`]). Recognised
/// command backends: `docker`, `microsandbox`, `opensandbox`, `mxc`, `daytona`, `box`,
/// `local` (opt-in, no isolation), `ssh`, and `singularity`. `modal` and
/// `vercel_sandbox` are recognised vocabulary but not implemented and error here
/// with an actionable hint ([`unimplemented_backend_hint`]).
///
/// The CLI wrappers (`docker`/`microsandbox`/`opensandbox`) and the remote HTTP
/// backend (`daytona`) all construct without I/O and never install/provision
/// anything; reachability is a runtime probe via each backend's `detect()`.
pub fn build_command_backend(backend: &SandboxBackend) -> Result<Box<dyn Sandbox>> {
    match backend {
        SandboxBackend::Docker => Ok(Box::new(docker::DockerSandbox::new())),
        SandboxBackend::Microsandbox => Ok(Box::new(microsandbox::MicrosandboxSandbox::new())),
        SandboxBackend::Opensandbox => Ok(Box::new(opensandbox::OpenSandboxSandbox::new())),
        SandboxBackend::Mxc => Ok(Box::new(mxc::MxcSandbox::new())),
        SandboxBackend::Daytona => Ok(Box::new(daytona::DaytonaSandbox::new())),
        SandboxBackend::Box => Ok(Box::new(box_backend::BoxSandbox::new())),
        SandboxBackend::Local => Ok(Box::new(local::LocalSandbox::new())),
        SandboxBackend::Ssh => Ok(Box::new(ssh::SshSandbox::new())),
        SandboxBackend::Singularity => Ok(Box::new(singularity::SingularitySandbox::new())),
        SandboxBackend::Wasmtime => Err(anyhow!(
            "wasmtime is not a command backend — pass a WASM module via `wasm_b64`"
        )),
        other => Err(anyhow!(
            "sandbox backend '{}' is recognized but not implemented: {}",
            other.as_str(),
            unimplemented_backend_hint(other.as_str())
        )),
    }
}

/// Operator-facing guidance for a recognised-but-unimplemented backend. Core
/// never falls back to another backend, so the error has to say what to do.
///
/// Modal sandboxes are created through Modal's Python SDK (there is no stable
/// CLI verb for create/exec/terminate), and Vercel Sandbox is driven through
/// its TypeScript SDK/REST API with a Vercel OIDC or access token; neither has
/// a contract Core can exercise without the provider, so both stay unwired
/// rather than shipping an untested remote-execution path.
pub fn unimplemented_backend_hint(name: &str) -> &'static str {
    match name {
        "modal" => {
            "Core has no Modal driver (Modal sandboxes are created through Modal's Python SDK). \
             Provide it as a backend plugin that owns the Modal token, or select an implemented \
             backend such as `docker`, `singularity`, `daytona`, or `box`"
        }
        "vercel_sandbox" => {
            "Core has no Vercel Sandbox driver (Vercel Sandbox is driven by its SDK/REST API with \
             a Vercel token). Provide it as a backend plugin that owns the Vercel credentials, or \
             select an implemented backend such as `docker`, `singularity`, `daytona`, or `box`"
        }
        _ => "no provider driver is wired in Core; select an implemented backend",
    }
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── SandboxCapabilities ───────────────────────────────────────────────────

    #[test]
    fn capabilities_default_is_deny_all() {
        let caps = SandboxCapabilities::default();
        assert!(
            caps.fs_read_paths.is_empty(),
            "default must have no FS read paths"
        );
        assert!(
            caps.fs_write_paths.is_empty(),
            "default must have no FS write paths"
        );
        assert!(!caps.network, "default must deny network");
    }

    #[test]
    fn capabilities_explicit_grant() {
        let mut caps = SandboxCapabilities::default();
        caps.fs_read_paths.insert(PathBuf::from("/tmp/read-me"));
        caps.network = true;

        assert_eq!(caps.fs_read_paths.len(), 1);
        assert!(caps.network);
        assert!(caps.fs_write_paths.is_empty());
    }

    // ── from_permissions (the wasmtime/Docker lowering) ───────────────────────

    #[test]
    fn from_permissions_default_is_deny_all() {
        // A deny-all PermissionSet must lower to the deny-all SandboxCapabilities —
        // the invariant that keeps a plugin declaring nothing at today's posture.
        use ryu_kernel_contracts::manifest::PermissionSet;
        let caps = SandboxCapabilities::from_permissions(&PermissionSet::default());
        assert_eq!(caps, SandboxCapabilities::default());
        assert!(caps.fs_read_paths.is_empty());
        assert!(caps.fs_write_paths.is_empty());
        assert!(!caps.network);
    }

    #[test]
    fn from_permissions_maps_fs_and_network() {
        use ryu_kernel_contracts::manifest::{NetworkPermission, PermissionSet};
        let mut perms = PermissionSet::default();
        perms.fs.read.push("/data/in".to_string());
        perms.fs.write.push("/data/out".to_string());
        perms.network = NetworkPermission::All(true);
        let caps = SandboxCapabilities::from_permissions(&perms);
        assert!(caps.fs_read_paths.contains(&PathBuf::from("/data/in")));
        assert!(caps.fs_write_paths.contains(&PathBuf::from("/data/out")));
        assert!(caps.network, "all-network lowers to true");
    }

    #[test]
    fn from_permissions_host_scoped_network_lowers_to_true() {
        // The WASI/Docker network knob is all-or-nothing: a host list opens the
        // boolean (this backend cannot scope egress by host).
        use ryu_kernel_contracts::manifest::{NetworkPermission, PermissionSet};
        let mut perms = PermissionSet::default();
        perms.network = NetworkPermission::Hosts(vec!["api.example.com:443".to_string()]);
        let caps = SandboxCapabilities::from_permissions(&perms);
        assert!(caps.network, "a non-empty host list permits network");
        // An empty host list is deny-all → network false.
        let mut deny = PermissionSet::default();
        deny.network = NetworkPermission::Hosts(vec![]);
        assert!(!SandboxCapabilities::from_permissions(&deny).network);
    }

    #[test]
    fn from_permissions_drops_child_process_and_tool() {
        // Neither has a SandboxCapabilities representation — the wasmtime/Docker
        // sandbox is subprocess-less and tools are stdio-brokered.
        use ryu_kernel_contracts::manifest::PermissionSet;
        let perms = PermissionSet {
            child_process: true,
            tool: vec!["web_search".to_string()],
            ..PermissionSet::default()
        };
        let caps = SandboxCapabilities::from_permissions(&perms);
        // No panic, no capability leak: the FS/network posture stays deny-all.
        assert_eq!(caps, SandboxCapabilities::default());
    }

    // ── SandboxScope + WorkspaceAccess ────────────────────────────────────────

    #[test]
    fn scope_and_access_defaults_match_today() {
        // The default capability descriptor must describe today's per-exec,
        // honor-the-path-sets behavior so adding the fields is a no-op.
        let caps = SandboxCapabilities::default();
        assert_eq!(caps.scope, SandboxScope::Exec);
        assert_eq!(caps.workspace_access, WorkspaceAccess::ReadWrite);
        assert_eq!(SandboxScope::default(), SandboxScope::Exec);
        assert_eq!(WorkspaceAccess::default(), WorkspaceAccess::ReadWrite);
    }

    #[test]
    fn scope_from_name_roundtrips_and_rejects_unknown() {
        for (name, variant) in [
            ("exec", SandboxScope::Exec),
            ("agent", SandboxScope::Agent),
            ("session", SandboxScope::Session),
            ("shared", SandboxScope::Shared),
        ] {
            assert_eq!(SandboxScope::from_name(name).unwrap(), variant);
            assert_eq!(variant.as_str(), name);
        }
        assert!(SandboxScope::from_name("galaxy").is_err());
    }

    #[test]
    fn access_from_name_accepts_aliases_and_rejects_unknown() {
        assert_eq!(
            WorkspaceAccess::from_name("none").unwrap(),
            WorkspaceAccess::None
        );
        for alias in ["read_only", "read-only", "ro"] {
            assert_eq!(
                WorkspaceAccess::from_name(alias).unwrap(),
                WorkspaceAccess::ReadOnly
            );
        }
        for alias in ["read_write", "read-write", "rw"] {
            assert_eq!(
                WorkspaceAccess::from_name(alias).unwrap(),
                WorkspaceAccess::ReadWrite
            );
        }
        assert!(WorkspaceAccess::from_name("append").is_err());
    }

    #[test]
    fn scope_and_access_serde_snake_case() {
        assert_eq!(
            serde_json::to_string(&SandboxScope::Session).unwrap(),
            "\"session\""
        );
        assert_eq!(
            serde_json::to_string(&WorkspaceAccess::ReadOnly).unwrap(),
            "\"read_only\""
        );
        let scope: SandboxScope = serde_json::from_str("\"shared\"").unwrap();
        assert_eq!(scope, SandboxScope::Shared);
        let access: WorkspaceAccess = serde_json::from_str("\"none\"").unwrap();
        assert_eq!(access, WorkspaceAccess::None);
    }

    // ── effective_mounts (the shared FS clamp) ────────────────────────────────

    #[test]
    fn effective_mounts_read_write_is_todays_behavior() {
        let mut caps = SandboxCapabilities::default();
        caps.fs_read_paths.insert(PathBuf::from("/data/in"));
        caps.fs_write_paths.insert(PathBuf::from("/data/out"));
        let mounts: std::collections::HashMap<PathBuf, bool> =
            caps.effective_mounts().into_iter().collect();
        assert_eq!(mounts.len(), 2);
        assert_eq!(mounts[&PathBuf::from("/data/in")], false);
        assert_eq!(mounts[&PathBuf::from("/data/out")], true);
    }

    #[test]
    fn effective_mounts_read_only_clamps_write_paths() {
        let mut caps = SandboxCapabilities::default();
        caps.fs_write_paths.insert(PathBuf::from("/data/out"));
        caps.workspace_access = WorkspaceAccess::ReadOnly;
        let mounts = caps.effective_mounts();
        assert_eq!(mounts.len(), 1);
        // A path that was writable is clamped to read-only.
        assert_eq!(mounts[0], (PathBuf::from("/data/out"), false));
    }

    #[test]
    fn effective_mounts_none_strips_all() {
        let mut caps = SandboxCapabilities::default();
        caps.fs_read_paths.insert(PathBuf::from("/data/in"));
        caps.fs_write_paths.insert(PathBuf::from("/data/out"));
        caps.workspace_access = WorkspaceAccess::None;
        assert!(
            caps.effective_mounts().is_empty(),
            "None access must strip every mount"
        );
    }

    // ── SandboxBackend ────────────────────────────────────────────────────────

    #[test]
    fn backend_from_known_names() {
        assert_eq!(
            SandboxBackend::from_name("wasmtime").unwrap(),
            SandboxBackend::Wasmtime
        );
        assert_eq!(
            SandboxBackend::from_name("docker").unwrap(),
            SandboxBackend::Docker
        );
        assert_eq!(
            SandboxBackend::from_name("box").unwrap(),
            SandboxBackend::Box
        );
    }

    #[test]
    fn unknown_backend_is_rejected() {
        // "subprocess" was a selectable variant whose builder ALWAYS errored with
        // "not implemented yet", so `RYU_SANDBOX_BACKEND=subprocess` silently
        // disabled every sandboxed exec on the node. It is not a backend: it now
        // parses as an unrecognised custom name and fails loudly at build time,
        // with the same honest message any other typo gets.
        let err = SandboxBackend::from_name("subprocess")
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("unknown sandbox backend"),
            "expected the honest unknown-backend error, got: {err}"
        );
        // It was never in the selectable set, and must not creep back in.
        assert!(!KNOWN_BACKENDS.contains(&"subprocess"));
    }

    #[test]
    fn backend_provider_names_can_be_discovered_without_core_branches() {
        let b = backend_descriptor("modal").unwrap();
        assert_eq!(b.name, "modal");
        assert!(!b.implemented);
        assert!(b.remote);
        assert!(!b.available);
        assert!(b.diagnostic.is_none());
    }

    #[test]
    fn backend_empty_name_errors() {
        assert!(SandboxBackend::from_name("").is_err());
    }

    #[test]
    fn backend_as_str_roundtrips() {
        for (variant, expected) in [
            (SandboxBackend::Wasmtime, "wasmtime"),
            (SandboxBackend::Docker, "docker"),
            (SandboxBackend::Box, "box"),
        ] {
            assert_eq!(variant.as_str(), expected);
        }
    }

    // ── select_backend ────────────────────────────────────────────────────────

    #[test]
    fn select_backend_no_preference_returns_default() {
        let backend = select_backend(None).unwrap();
        assert_eq!(backend, default_backend());
    }

    #[test]
    fn select_backend_named_preference() {
        assert_eq!(
            select_backend(Some("wasmtime")).unwrap(),
            SandboxBackend::Wasmtime
        );
        assert_eq!(
            select_backend(Some("docker")).unwrap(),
            SandboxBackend::Docker
        );
    }

    #[test]
    fn select_backend_unknown_name_rejected() {
        let err = select_backend(Some("nsjail")).unwrap_err();
        assert!(err.to_string().contains("unknown sandbox backend 'nsjail'"));
    }

    #[test]
    fn select_backend_empty_string_errors() {
        assert!(select_backend(Some("")).is_err());
    }

    // ── ExecSpec ──────────────────────────────────────────────────────────────

    #[test]
    fn exec_spec_default_deny_all() {
        let spec = ExecSpec::new("echo", vec!["hello".to_owned()]);
        assert!(!spec.capabilities.network);
        assert!(spec.capabilities.fs_read_paths.is_empty());
        assert!(spec.capabilities.fs_write_paths.is_empty());
        assert!(spec.stdin.is_none());
        assert!(spec.timeout_secs.is_none());
    }

    // ── build_command_backend ─────────────────────────────────────────────────

    #[test]
    fn build_command_backend_recognises_cli_backends() {
        assert_eq!(
            build_command_backend(&SandboxBackend::Docker)
                .unwrap()
                .name(),
            "docker"
        );
        assert_eq!(
            build_command_backend(&SandboxBackend::from_name("microsandbox").unwrap())
                .unwrap()
                .name(),
            "microsandbox"
        );
        assert_eq!(
            build_command_backend(&SandboxBackend::from_name("opensandbox").unwrap())
                .unwrap()
                .name(),
            "opensandbox"
        );
        assert_eq!(
            build_command_backend(&SandboxBackend::from_name("mxc").unwrap())
                .unwrap()
                .name(),
            "mxc"
        );
        assert_eq!(
            build_command_backend(&SandboxBackend::Box).unwrap().name(),
            "box"
        );
    }

    #[test]
    fn build_command_backend_rejects_wasmtime_and_unknown() {
        assert!(build_command_backend(&SandboxBackend::Wasmtime).is_err());
        assert!(SandboxBackend::from_name("nope").is_err());
    }

    // ── configured_backend ────────────────────────────────────────────────────

    #[test]
    fn configured_backend_defaults_to_wasmtime() {
        std::env::remove_var(ENV_SANDBOX_BACKEND);
        assert_eq!(configured_backend(), SandboxBackend::Wasmtime);
    }

    // ── SandboxBackendStore ───────────────────────────────────────────────────

    #[test]
    fn sandbox_backend_store_serde_round_trips() {
        // The persisted shape `configured_backend` reads back. Tested at the serde
        // layer (not the filesystem) because `ryu_dir()` is process-cached, so a
        // path-redirected file test would be unreliable in the shared test bin.
        let store = SandboxBackendStore {
            default: Some("docker".to_owned()),
        };
        let json = serde_json::to_string(&store).unwrap();
        let back: SandboxBackendStore = serde_json::from_str(&json).unwrap();
        assert_eq!(back.default.as_deref(), Some("docker"));
        // A missing/empty document → no selection (so the resolver falls through
        // to the env/default layers).
        let empty: SandboxBackendStore = serde_json::from_str("{}").unwrap();
        assert!(empty.default.is_none());
    }

    #[test]
    fn known_backends_have_display_names_and_build() {
        for name in KNOWN_BACKENDS {
            assert_ne!(backend_display_name(name), "");
            // Only implemented command backends are buildable. Recognized
            // provider vocabulary remains honest and explicitly unavailable.
            if backend_descriptor(name).unwrap().implemented && *name != "wasmtime" {
                assert!(
                    build_command_backend(&SandboxBackend::from_name(name).unwrap()).is_ok(),
                    "{name} must build as a command backend"
                );
            }
        }
    }

    #[tokio::test]
    async fn discovery_is_stable_and_reports_conformance() {
        let discovered = discover_backends().await;
        let names: Vec<&str> = discovered.iter().map(|b| b.name.as_str()).collect();
        assert_eq!(names, KNOWN_BACKENDS);
        let daytona = discovered.iter().find(|b| b.name == "daytona").unwrap();
        assert!(daytona.implemented);
        assert!(daytona.remote);
        assert!(daytona.persistence.contains("persistent"));
        assert!(!daytona.isolation.is_empty());
        let box_backend = discovered.iter().find(|b| b.name == "box").unwrap();
        assert!(box_backend.implemented);
        assert!(box_backend.remote);
        assert!(box_backend.persistence.contains("durable"));
        let modal = discovered.iter().find(|b| b.name == "modal").unwrap();
        assert!(!modal.implemented);
        assert!(!modal.available);
        assert!(modal
            .diagnostic
            .as_deref()
            .unwrap()
            .contains("not implemented"));
        let local = discovered.iter().find(|b| b.name == "local").unwrap();
        assert!(local.implemented);
        assert!(!local.remote);
        assert!(local.isolation.starts_with("none"));
        let ssh = discovered.iter().find(|b| b.name == "ssh").unwrap();
        assert!(ssh.implemented);
        assert!(ssh.remote);
    }

    #[test]
    fn unimplemented_providers_are_reported_and_refuse_to_build() {
        for name in ["modal", "vercel_sandbox"] {
            let descriptor = backend_descriptor(name).unwrap();
            assert!(!descriptor.implemented, "{name}");
            let err = build_command_backend(&SandboxBackend::from_name(name).unwrap())
                .err()
                .unwrap()
                .to_string();
            assert!(err.contains("not implemented"), "{name}: {err}");
            assert!(
                err.contains("plugin"),
                "{name}: actionable hint missing: {err}"
            );
            assert!(
                err.contains("`docker`"),
                "{name}: alternatives missing: {err}"
            );
        }
    }

    #[test]
    fn singularity_is_an_implemented_local_command_backend() {
        let descriptor = backend_descriptor("singularity").unwrap();
        assert!(descriptor.implemented);
        assert!(!descriptor.remote);
        assert_eq!(
            build_command_backend(&SandboxBackend::Singularity)
                .unwrap()
                .name(),
            "singularity"
        );
    }

    #[test]
    fn build_command_backend_builds_local_and_ssh() {
        assert_eq!(
            build_command_backend(&SandboxBackend::Local)
                .unwrap()
                .name(),
            "local"
        );
        assert_eq!(
            build_command_backend(&SandboxBackend::Ssh).unwrap().name(),
            "ssh"
        );
    }
}
