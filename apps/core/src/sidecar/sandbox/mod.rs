//! Core Sandbox trait: ephemeral exec and long-lived workspace abstraction.
//!
//! Backend implementations live in sub-modules:
//! - [`wasmtime`] — wasmtime/WASI in-process ephemeral exec (M6 default)
//! - [`docker`] — Docker/OCI containers via the `docker` CLI (detect-only)
//! - [`microsandbox`] — microVMs via the `msb` CLI (detect-only)
//! - [`opensandbox`] — gVisor/Kata/Firecracker via the `osb` CLI (detect-only)
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

pub mod docker;
pub mod microsandbox;
pub mod opensandbox;
pub mod wasmtime;

use std::collections::HashSet;
use std::path::PathBuf;

use anyhow::{anyhow, Result};
use serde::{Deserialize, Serialize};

use crate::sidecar::BoxFuture;

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
}

impl Default for SandboxCapabilities {
    /// Returns the deny-all default: no FS paths, no network.
    fn default() -> Self {
        Self {
            fs_read_paths: HashSet::new(),
            fs_write_paths: HashSet::new(),
            network: false,
        }
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
    /// Timeout in seconds. `None` means no timeout (use with care).
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
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct WorkspaceId(pub String);

// ── Sandbox trait ────────────────────────────────────────────────────────────

/// Contract implemented by every sandbox backend.
///
/// Mirrors the [`crate::sidecar::Sidecar`] trait style: all async methods
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
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum SandboxBackend {
    /// Subprocess sandbox: spawn a child process with a restricted environment.
    /// Available on all platforms; lowest isolation, useful for trusted code.
    Subprocess,
    /// wasmtime backend: run a WASM/WASI module with strict capability limits.
    /// The default secure backend when available.
    Wasmtime,
    /// Docker/OCI backend: run a container image. Opt-in; requires Docker daemon.
    Docker,
    /// Custom backend identified by name.
    Custom(String),
}

impl SandboxBackend {
    /// Parse a backend name string into the enum.
    pub fn from_name(name: &str) -> Result<Self> {
        match name {
            "subprocess" => Ok(Self::Subprocess),
            "wasmtime" => Ok(Self::Wasmtime),
            "docker" => Ok(Self::Docker),
            "" => Err(anyhow!("sandbox backend name must not be empty")),
            other => Ok(Self::Custom(other.to_owned())),
        }
    }

    /// Canonical string name for this backend.
    pub fn as_str(&self) -> &str {
        match self {
            Self::Subprocess => "subprocess",
            Self::Wasmtime => "wasmtime",
            Self::Docker => "docker",
            Self::Custom(name) => name.as_str(),
        }
    }
}

/// Select the most suitable available backend, given a preferred name.
///
/// - If `preferred` is `Some`, parse and return it (error on unknown names that
///   are not `Custom`-compatible is handled by the caller building the backend).
/// - If `preferred` is `None`, return the platform default (`wasmtime` when
///   available, `subprocess` as universal fallback).
///
/// This function never silently falls back from a *named* backend to another.
pub fn select_backend(preferred: Option<&str>) -> Result<SandboxBackend> {
    match preferred {
        Some(name) => SandboxBackend::from_name(name),
        None => Ok(default_backend()),
    }
}

/// Platform default backend: `wasmtime` is preferred; `subprocess` is the
/// universal fallback (available everywhere, no external daemon required).
///
/// The actual availability check (is wasmtime on PATH?) happens when the
/// backend is constructed, not here. This function only names the preference.
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
/// the built-in default; the rest are detect-only external CLIs.
pub const KNOWN_BACKENDS: &[&str] = &["wasmtime", "docker", "microsandbox", "opensandbox"];

/// Human-facing label for a known backend (`name` for anything unknown).
pub fn backend_display_name(name: &str) -> &str {
    match name {
        "wasmtime" => "Wasmtime (WASM · built-in)",
        "docker" => "Docker",
        "microsandbox" => "microsandbox",
        "opensandbox" => "OpenSandbox",
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
        _ => false,
    }
}

/// Path of the persisted default-backend selection.
fn sandbox_backend_path() -> PathBuf {
    crate::paths::ryu_dir().join("sandbox-backend.json")
}

/// Durable record of the picker-selected default sandbox backend, persisted to
/// `~/.ryu/sandbox-backend.json`. Mirrors `ActiveEngineStore`'s load/save shape.
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
/// WASM module instead), for [`SandboxBackend::Subprocess`] (no host-process
/// backend is built yet), and for unknown `Custom` names. Recognised command
/// backends: `docker`, `microsandbox`, `opensandbox`.
///
/// All three are detect-only CLI wrappers — construction does no I/O and never
/// installs anything; reachability is a runtime probe via each backend's
/// `detect()`.
pub fn build_command_backend(backend: &SandboxBackend) -> Result<Box<dyn Sandbox>> {
    match backend {
        SandboxBackend::Docker => Ok(Box::new(docker::DockerSandbox::new())),
        SandboxBackend::Custom(name) if name == "microsandbox" => {
            Ok(Box::new(microsandbox::MicrosandboxSandbox::new()))
        }
        SandboxBackend::Custom(name) if name == "opensandbox" => {
            Ok(Box::new(opensandbox::OpenSandboxSandbox::new()))
        }
        SandboxBackend::Wasmtime => Err(anyhow!(
            "wasmtime is not a command backend — pass a WASM module via `wasm_b64`"
        )),
        SandboxBackend::Subprocess => Err(anyhow!("the subprocess backend is not implemented yet")),
        SandboxBackend::Custom(other) => Err(anyhow!("unknown sandbox backend '{other}'")),
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

    // ── SandboxBackend ────────────────────────────────────────────────────────

    #[test]
    fn backend_from_known_names() {
        assert_eq!(
            SandboxBackend::from_name("subprocess").unwrap(),
            SandboxBackend::Subprocess
        );
        assert_eq!(
            SandboxBackend::from_name("wasmtime").unwrap(),
            SandboxBackend::Wasmtime
        );
        assert_eq!(
            SandboxBackend::from_name("docker").unwrap(),
            SandboxBackend::Docker
        );
    }

    #[test]
    fn backend_custom_name() {
        let b = SandboxBackend::from_name("my-custom-backend").unwrap();
        assert_eq!(b, SandboxBackend::Custom("my-custom-backend".to_owned()));
        assert_eq!(b.as_str(), "my-custom-backend");
    }

    #[test]
    fn backend_empty_name_errors() {
        assert!(SandboxBackend::from_name("").is_err());
    }

    #[test]
    fn backend_as_str_roundtrips() {
        for (variant, expected) in [
            (SandboxBackend::Subprocess, "subprocess"),
            (SandboxBackend::Wasmtime, "wasmtime"),
            (SandboxBackend::Docker, "docker"),
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
            select_backend(Some("subprocess")).unwrap(),
            SandboxBackend::Subprocess
        );
        assert_eq!(
            select_backend(Some("docker")).unwrap(),
            SandboxBackend::Docker
        );
    }

    #[test]
    fn select_backend_custom_name_accepted() {
        let b = select_backend(Some("nsjail")).unwrap();
        assert_eq!(b, SandboxBackend::Custom("nsjail".to_owned()));
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
    }

    #[test]
    fn build_command_backend_rejects_wasmtime_and_unknown() {
        assert!(build_command_backend(&SandboxBackend::Wasmtime).is_err());
        assert!(build_command_backend(&SandboxBackend::Subprocess).is_err());
        assert!(build_command_backend(&SandboxBackend::from_name("nope").unwrap()).is_err());
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
            // Every known backend except wasmtime is a buildable command backend.
            if *name != "wasmtime" {
                assert!(
                    build_command_backend(&SandboxBackend::from_name(name).unwrap()).is_ok(),
                    "{name} must build as a command backend"
                );
            }
        }
    }
}
