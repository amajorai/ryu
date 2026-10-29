//! OS-level isolation for long-running **native sidecar** processes.
//!
//! This is not the JS tool sandbox (QuickJS/Wasmtime in `ryu-tool-exec`) and not
//! the command backends above. It confines a manifest-declared sidecar process
//! that Core spawns and supervises, using whatever the host OS provides:
//!
//! | OS      | Backend                                   | Filesystem confinement |
//! |---------|-------------------------------------------|------------------------|
//! | Linux   | Landlock (best-effort ABI) + `no_new_privs` | yes, when the kernel supports Landlock |
//! | macOS   | Seatbelt profile via `/usr/bin/sandbox-exec` | yes |
//! | Windows | Job Object (kill-on-close, optional memory cap) | no |
//!
//! Network access is never filtered: sidecars serve HTTP on loopback.
//!
//! The module is split into a pure half (policy derivation and Seatbelt profile
//! generation, testable on every OS) and a platform half ([`prepare`] and the
//! per-OS hooks on [`PreparedIsolation`]). Core owns the mode setting and the
//! status record; this crate owns no global state.

use std::path::{Path, PathBuf};

use ryu_kernel_contracts::{parse_sandbox_path, SandboxPathBase, SidecarSandboxSpec};
use ryu_sidecar_runtime::layout;
use serde::Serialize;

pub use ryu_kernel_contracts::SidecarSandboxMode as IsolationMode;

/// The concrete directories a sidecar's policy is derived from. Core fills these
/// from its own path helpers; tests pass temp directories.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IsolationRoots {
    /// This app's own directory (`<plugins_dir>/<plugin>`): `$APP_DATA`.
    pub app_data: PathBuf,
    /// This app's own data directory (`<ryu_dir>/plugin-data/<plugin>`, the
    /// sidecar's `RYU_PLUGIN_DATA_DIR`). Always granted read-write; every other
    /// entry of `<ryu_dir>/plugin-data` is another app's data and is refused.
    pub plugin_data: PathBuf,
    /// Core's data directory: `$RYU_DIR`.
    pub ryu_dir: PathBuf,
    /// The directory holding every app's own directory.
    pub plugins_dir: PathBuf,
    /// The user's home directory: `$HOME`. `None` when it cannot be resolved,
    /// in which case `$HOME/...` declarations are refused.
    pub home: Option<PathBuf>,
    /// The system temp directory: `$TMP`.
    pub temp: PathBuf,
}

/// The filesystem policy for one sidecar process. Every path is absolute and,
/// where it exists, canonical (symlinks resolved), so the backends and the
/// overlap checks see the same thing the kernel will.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
pub struct IsolationPolicy {
    /// Read and execute access (system libraries, runtime and install dirs,
    /// declared `fs.read`).
    pub read_only: Vec<PathBuf>,
    /// Read, write, and execute access (`$APP_DATA`, the app's own data dir,
    /// the temp dir, declared `fs.write`).
    pub read_write: Vec<PathBuf>,
    /// Directories whose contents are hidden unless granted above (the home and
    /// Core data directories). Used by backends that allow reads by default.
    pub protected: Vec<PathBuf>,
    /// The resolved executable, when it could be resolved.
    pub program: Option<PathBuf>,
    /// Optional memory cap in MiB (Windows Job Object only).
    pub memory_limit_mb: Option<u64>,
    /// Human-readable notes about grants that were skipped and why.
    pub notes: Vec<String>,
}

/// Which platform mechanism isolates the process.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum IsolationBackend {
    /// No backend: mode `off`, or no mechanism on this platform.
    None,
    /// Linux Landlock plus `PR_SET_NO_NEW_PRIVS`.
    Landlock,
    /// macOS Seatbelt via `/usr/bin/sandbox-exec`.
    Seatbelt,
    /// Windows Job Object.
    JobObject,
}

impl IsolationBackend {
    /// The backend this build would use in `enforce` mode.
    pub fn for_platform() -> Self {
        if cfg!(target_os = "linux") {
            Self::Landlock
        } else if cfg!(target_os = "macos") {
            Self::Seatbelt
        } else if cfg!(windows) {
            Self::JobObject
        } else {
            Self::None
        }
    }

    /// Display name used in logs and error messages.
    pub fn label(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::Landlock => "Landlock",
            Self::Seatbelt => "Seatbelt",
            Self::JobObject => "Windows Job Object",
        }
    }
}

/// The effective isolation of one sidecar process, as reported on the status
/// surface. Field names are wire contract.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct IsolationStatus {
    /// The effective mode after combining the operator setting and the manifest.
    pub mode: IsolationMode,
    /// The backend in use (or that would be used, in `audit` mode).
    pub backend: IsolationBackend,
    /// Whether a backend restriction is actually applied to the process.
    pub enforced: bool,
    /// Whether filesystem access is actually confined.
    pub fs_restricted: bool,
    /// Why the status is what it is, when that is not obvious (fallbacks).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

impl IsolationStatus {
    /// The status of a sidecar whose isolation mode is `off`.
    pub fn off() -> Self {
        Self {
            mode: IsolationMode::Off,
            backend: IsolationBackend::None,
            enforced: false,
            fs_restricted: false,
            detail: None,
        }
    }
}

// ── Policy derivation (pure) ────────────────────────────────────────────────

/// Read-only system and runtime locations for this platform. Paths that do not
/// exist on the host are dropped at derivation time.
pub fn system_read_paths() -> Vec<PathBuf> {
    let list: &[&str] = if cfg!(target_os = "macos") {
        &[
            "/System",
            "/usr",
            "/bin",
            "/sbin",
            "/Library",
            "/private/etc",
            "/private/var/db",
            "/opt/homebrew",
            "/opt/local",
            "/dev",
        ]
    } else if cfg!(windows) {
        &[]
    } else {
        &[
            "/usr",
            "/lib",
            "/lib32",
            "/lib64",
            "/libx32",
            "/bin",
            "/sbin",
            "/etc",
            "/opt",
            "/proc",
            "/sys",
            "/run",
            "/dev",
            "/nix/store",
        ]
    };
    list.iter().map(PathBuf::from).collect()
}

/// Device nodes a sidecar may write on Linux (read access to `/dev` comes from
/// [`system_read_paths`]).
#[cfg(any(target_os = "linux", test))]
const LINUX_DEVICE_WRITE: &[&str] = &[
    "/dev/null",
    "/dev/zero",
    "/dev/full",
    "/dev/random",
    "/dev/urandom",
    "/dev/tty",
    "/dev/ptmx",
    "/dev/pts",
    "/dev/shm",
];

/// Device nodes a sidecar may write on macOS.
const MACOS_DEVICE_WRITE: &[&str] = &["/dev/null", "/dev/zero", "/dev/tty", "/dev/dtracehelper"];

/// Canonicalize when the path exists; otherwise keep it as given.
fn canonical(path: &Path) -> PathBuf {
    std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}

/// `a` is `b` or one of `b`'s ancestors.
fn is_ancestor_or_equal(a: &Path, b: &Path) -> bool {
    b.starts_with(a)
}

/// Canonical roots used by every overlap check.
struct CanonicalRoots {
    app_data: PathBuf,
    plugin_data: PathBuf,
    plugin_data_root: PathBuf,
    models: PathBuf,
    ryu_dir: PathBuf,
    plugins_dir: PathBuf,
    home: Option<PathBuf>,
    temp: PathBuf,
}

impl CanonicalRoots {
    fn new(roots: &IsolationRoots) -> Self {
        Self {
            app_data: canonical(&roots.app_data),
            plugin_data: canonical(&roots.plugin_data),
            plugin_data_root: canonical(&layout::plugin_data_root(&roots.ryu_dir)),
            models: canonical(&layout::models_root(&roots.ryu_dir)),
            ryu_dir: canonical(&roots.ryu_dir),
            plugins_dir: canonical(&roots.plugins_dir),
            home: roots.home.as_deref().map(canonical),
            temp: canonical(&roots.temp),
        }
    }

    /// Why `path` must not be granted, if it must not: it would expose another
    /// app's directory, or a whole directory that contains every app's data.
    fn refuse_reason(&self, path: &Path) -> Option<String> {
        if !path.is_absolute() {
            return Some("is not absolute".to_owned());
        }
        if path.parent().is_none() {
            return Some("is the filesystem root".to_owned());
        }
        if path.starts_with(&self.plugins_dir) && !path.starts_with(&self.app_data) {
            return Some("is inside another app's directory".to_owned());
        }
        if path.starts_with(&self.plugin_data_root) && !path.starts_with(&self.plugin_data) {
            return Some("is inside another app's data directory".to_owned());
        }
        let broad = [
            Some(&self.plugins_dir),
            Some(&self.plugin_data_root),
            Some(&self.ryu_dir),
            self.home.as_ref(),
        ];
        if broad
            .into_iter()
            .flatten()
            .any(|root| is_ancestor_or_equal(path, root))
        {
            return Some("would expose the whole home, Core data, or apps directory".to_owned());
        }
        None
    }
}

/// Resolve one declared placeholder path against `roots`, refusing anything that
/// resolves (after following symlinks) outside its own root, into another app's
/// directory, or to a directory containing the home/Core/apps directories.
pub fn resolve_declared_path(raw: &str, roots: &IsolationRoots) -> Result<PathBuf, String> {
    let parsed = parse_sandbox_path(raw)?;
    let canon = CanonicalRoots::new(roots);
    let base = match parsed.base {
        SandboxPathBase::AppData => canon.app_data.clone(),
        SandboxPathBase::RyuDir => canon.ryu_dir.clone(),
        SandboxPathBase::Home => canon.home.clone().ok_or_else(|| {
            format!("sandbox path '{raw}' uses $HOME but no home directory is known")
        })?,
        SandboxPathBase::Tmp => canon.temp.clone(),
    };
    let joined = parsed
        .segments
        .iter()
        .fold(base.clone(), |path, segment| path.join(segment));
    let resolved = canonical(&joined);
    if !resolved.starts_with(&base) {
        return Err(format!(
            "sandbox path '{raw}' resolves to {} which is outside its root {}",
            resolved.display(),
            base.display()
        ));
    }
    // The own-app root is allowed to sit under the apps directory by definition.
    if parsed.base != SandboxPathBase::AppData {
        if let Some(reason) = canon.refuse_reason(&resolved) {
            return Err(format!("sandbox path '{raw}' {reason}"));
        }
    }
    Ok(resolved)
}

/// The directories an executable needs to load itself: its own directory and,
/// when that is a `bin` directory, the install prefix above it (for `lib/`,
/// `share/`, a Python stdlib, …). Both the path as given and its canonical form
/// are considered, so a venv `python` symlink also grants the base interpreter.
fn install_dirs(program: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for candidate in [program.to_path_buf(), canonical(program)] {
        let Some(parent) = candidate.parent() else {
            continue;
        };
        out.push(parent.to_path_buf());
        if parent.file_name().is_some_and(|name| name == "bin") {
            if let Some(prefix) = parent.parent() {
                out.push(prefix.to_path_buf());
            }
        }
    }
    out
}

/// Push `path` (canonicalized) unless it is refused, recording why when it is.
fn push_grant(
    out: &mut Vec<PathBuf>,
    notes: &mut Vec<String>,
    canon: &CanonicalRoots,
    path: &Path,
    what: &str,
) {
    let path = canonical(path);
    if let Some(reason) = canon.refuse_reason(&path) {
        notes.push(format!(
            "{what} {} not granted: it {reason}",
            path.display()
        ));
        return;
    }
    if !out.contains(&path) {
        out.push(path);
    }
}

/// Derive the policy for one sidecar from its manifest declaration, Core's
/// roots, and the resolved executable, using this platform's system paths.
pub fn derive_policy(
    declared: Option<&SidecarSandboxSpec>,
    roots: &IsolationRoots,
    program: Option<&Path>,
) -> Result<IsolationPolicy, String> {
    derive_policy_with(declared, roots, program, &system_read_paths())
}

/// [`derive_policy`] with an explicit system path list (for tests).
pub fn derive_policy_with(
    declared: Option<&SidecarSandboxSpec>,
    roots: &IsolationRoots,
    program: Option<&Path>,
    system_paths: &[PathBuf],
) -> Result<IsolationPolicy, String> {
    let canon = CanonicalRoots::new(roots);
    let mut policy = IsolationPolicy {
        memory_limit_mb: declared.and_then(|d| d.memory_limit_mb),
        ..IsolationPolicy::default()
    };

    // Read-write: the app's own directory and its own data directory (always),
    // and the temp directory (unless it contains the Core data directory, as in
    // some headless setups, in which case granting it would expose every app's
    // data). `app_data` stays first: the Seatbelt profile allows exec from it.
    policy.read_write.push(canon.app_data.clone());
    if canon.plugin_data.starts_with(&canon.plugin_data_root)
        && canon.plugin_data != canon.plugin_data_root
    {
        if !policy.read_write.contains(&canon.plugin_data) {
            policy.read_write.push(canon.plugin_data.clone());
        }
    } else {
        policy.notes.push(format!(
            "app data directory {} not granted: it is not an entry of {}",
            canon.plugin_data.display(),
            canon.plugin_data_root.display()
        ));
    }
    match canon.refuse_reason(&canon.temp) {
        None => policy.read_write.push(canon.temp.clone()),
        Some(reason) => policy.notes.push(format!(
            "temp directory {} not granted: it {reason}",
            canon.temp.display()
        )),
    }

    for path in system_paths.iter().filter(|p| p.exists()) {
        push_grant(
            &mut policy.read_only,
            &mut policy.notes,
            &canon,
            path,
            "system path",
        );
    }
    // The shared model store (`RYU_MODELS_DIR`) is readable; downloading into it
    // (`HF_HOME`, `TORCH_HOME`) needs an explicit `fs.write` declaration.
    if canon.models.exists() {
        push_grant(
            &mut policy.read_only,
            &mut policy.notes,
            &canon,
            &canon.models,
            "shared models directory",
        );
    }
    if let Some(program) = program {
        for dir in install_dirs(program) {
            push_grant(
                &mut policy.read_only,
                &mut policy.notes,
                &canon,
                &dir,
                "install directory",
            );
        }
        policy.program = Some(canonical(program));
    }

    if let Some(declared) = declared {
        for raw in &declared.fs.read {
            let path = resolve_declared_path(raw, roots)?;
            if !policy.read_only.contains(&path) {
                policy.read_only.push(path);
            }
        }
        for raw in &declared.fs.write {
            let path = resolve_declared_path(raw, roots)?;
            if !policy.read_write.contains(&path) {
                policy.read_write.push(path);
            }
        }
    }

    policy.protected = [Some(canon.ryu_dir.clone()), canon.home.clone()]
        .into_iter()
        .flatten()
        .collect();
    policy.protected.dedup();
    Ok(policy)
}

// ── Seatbelt profile (pure) ─────────────────────────────────────────────────

/// Quote a path as an SBPL string literal.
fn sbpl_string(path: &Path) -> String {
    let raw = path.to_string_lossy();
    let mut out = String::with_capacity(raw.len() + 2);
    out.push('"');
    for ch in raw.chars() {
        if ch == '"' || ch == '\\' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
    out
}

fn sbpl_rule(out: &mut String, verb: &str, operation: &str, filters: &[String]) {
    if filters.is_empty() {
        return;
    }
    out.push_str(&format!("({verb} {operation}\n"));
    for filter in filters {
        out.push_str("    ");
        out.push_str(filter);
        out.push('\n');
    }
    out.push_str(")\n");
}

fn subpaths(paths: &[PathBuf]) -> Vec<String> {
    paths
        .iter()
        .map(|p| format!("(subpath {})", sbpl_string(p)))
        .collect()
}

/// Generate the macOS Seatbelt (SBPL) profile for `policy`.
///
/// Shape (later rules take precedence in SBPL):
/// 1. everything is allowed by default (network, IPC, Mach services, sysctl),
///    because a deny-default profile breaks ordinary runtimes in ways that are
///    hard to predict;
/// 2. every file write is denied, then re-allowed under `read_write` and a few
///    device nodes;
/// 3. reading inside the protected roots (home, Core data) is denied, metadata
///    lookups there stay allowed so path resolution works, and reads are
///    re-allowed under `read_only` and `read_write`;
/// 4. every process exec is denied, then re-allowed for the program, the
///    `read_only` locations, and the app's own directory.
pub fn seatbelt_profile(policy: &IsolationPolicy) -> String {
    let mut out = String::from("(version 1)\n(allow default)\n(deny file-write*)\n");

    let mut writable = subpaths(&policy.read_write);
    writable.extend(
        MACOS_DEVICE_WRITE
            .iter()
            .map(|dev| format!("(literal {})", sbpl_string(Path::new(dev)))),
    );
    writable.push(format!("(subpath {})", sbpl_string(Path::new("/dev/fd"))));
    sbpl_rule(&mut out, "allow", "file-write*", &writable);

    let protected = subpaths(&policy.protected);
    sbpl_rule(&mut out, "deny", "file-read*", &protected);
    sbpl_rule(&mut out, "allow", "file-read-metadata", &protected);
    let mut readable = subpaths(&policy.read_only);
    readable.extend(subpaths(&policy.read_write));
    sbpl_rule(&mut out, "allow", "file-read*", &readable);

    out.push_str("(deny process-exec*)\n");
    let mut executable = Vec::new();
    if let Some(program) = &policy.program {
        executable.push(format!("(literal {})", sbpl_string(program)));
    }
    executable.extend(subpaths(&policy.read_only));
    if let Some(app_data) = policy.read_write.first() {
        executable.push(format!("(subpath {})", sbpl_string(app_data)));
    }
    sbpl_rule(&mut out, "allow", "process-exec*", &executable);
    out
}

// ── Launch preparation (platform) ───────────────────────────────────────────

/// Path of the macOS Seatbelt launcher.
pub const SANDBOX_EXEC: &str = "/usr/bin/sandbox-exec";

/// What to actually spawn for a sidecar under `mode`, plus the per-OS hooks
/// that apply the policy around the spawn. Keep it alive until the child has
/// been spawned (it owns the Landlock ruleset descriptor on Linux).
#[derive(Debug)]
pub struct PreparedIsolation {
    program: String,
    args: Vec<String>,
    status: IsolationStatus,
    #[cfg(target_os = "linux")]
    landlock: Option<std::os::fd::OwnedFd>,
    #[cfg(target_os = "linux")]
    no_new_privs: bool,
    #[cfg(windows)]
    memory_limit_mb: Option<u64>,
}

impl PreparedIsolation {
    /// The program to spawn (the original one, or the Seatbelt launcher).
    pub fn program(&self) -> &str {
        &self.program
    }

    /// The arguments to spawn it with.
    pub fn args(&self) -> &[String] {
        &self.args
    }

    /// The effective isolation status for the status surface.
    pub fn status(&self) -> &IsolationStatus {
        &self.status
    }

    /// Whether this launch changes anything about how the process is spawned.
    pub fn is_active(&self) -> bool {
        self.status.mode == IsolationMode::Enforce
    }

    /// Install the Linux confinement as a `pre_exec` hook: `PR_SET_NO_NEW_PRIVS`
    /// then `landlock_restrict_self` on the ruleset built in the parent. The
    /// hook issues only those two raw syscalls (async-signal-safe: no allocation,
    /// no locks). A failing syscall fails the spawn rather than starting the
    /// process unconfined. No-op unless the mode is `enforce`.
    #[cfg(target_os = "linux")]
    pub fn install_pre_exec(&self, command: &mut tokio::process::Command) {
        use std::os::fd::AsRawFd;
        if !self.is_active() {
            return;
        }
        let ruleset = self.landlock.as_ref().map(AsRawFd::as_raw_fd);
        let no_new_privs = self.no_new_privs;
        // SAFETY: the closure runs in the forked child before `exec` and only
        // issues `prctl` and `landlock_restrict_self`, both async-signal-safe;
        // it captures two `Copy` values and allocates nothing. The ruleset fd is
        // owned by `self`, which the caller keeps alive across `spawn`.
        unsafe {
            command.pre_exec(move || {
                if no_new_privs && libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0 {
                    return Err(std::io::Error::last_os_error());
                }
                if let Some(fd) = ruleset {
                    if libc::syscall(libc::SYS_landlock_restrict_self, fd, 0u32) != 0 {
                        return Err(std::io::Error::last_os_error());
                    }
                }
                Ok(())
            });
        }
    }

    /// Put the spawned child into a Job Object that kills the process tree when
    /// Core's handle closes and optionally caps its memory. Returns the guard
    /// that owns the job; dropping it terminates the tree. No-op (`Ok(None)`)
    /// unless the mode is `enforce`.
    ///
    /// The child is assigned right after it starts, so a descendant it spawns in
    /// that first instant is not contained.
    #[cfg(windows)]
    pub fn contain(&self, child: &tokio::process::Child) -> std::io::Result<Option<JobGuard>> {
        if !self.is_active() {
            return Ok(None);
        }
        let Some(handle) = child.raw_handle() else {
            return Ok(None);
        };
        JobGuard::assign(handle, self.memory_limit_mb).map(Some)
    }
}

/// Probe the running kernel's Landlock ABI version (`None` when unsupported).
#[cfg(target_os = "linux")]
pub fn landlock_abi_version() -> Option<i64> {
    const LANDLOCK_CREATE_RULESET_VERSION: u32 = 1;
    // SAFETY: the documented version query: a null attribute pointer with size 0.
    let version = unsafe {
        libc::syscall(
            libc::SYS_landlock_create_ruleset,
            std::ptr::null::<libc::c_void>(),
            0usize,
            LANDLOCK_CREATE_RULESET_VERSION,
        )
    };
    (version > 0).then_some(version)
}

#[cfg(target_os = "linux")]
fn build_landlock_ruleset(
    policy: &IsolationPolicy,
) -> Result<Option<std::os::fd::OwnedFd>, String> {
    use landlock::{
        path_beneath_rules, Access, AccessFs, Ruleset, RulesetAttr, RulesetCreatedAttr, ABI,
    };
    // V5 is the newest ABI whose rights stay filesystem-only: V9 adds
    // `ResolveUnix`, which would block connecting to Unix sockets.
    let abi = ABI::V5;
    let devices: Vec<PathBuf> = LINUX_DEVICE_WRITE.iter().map(PathBuf::from).collect();
    let ruleset = Ruleset::default()
        .handle_access(AccessFs::from_all(abi))
        .and_then(|r| r.create())
        .and_then(|r| {
            r.add_rules(path_beneath_rules(
                &policy.read_only,
                AccessFs::from_read(abi),
            ))
        })
        .and_then(|r| {
            r.add_rules(path_beneath_rules(
                &policy.read_write,
                AccessFs::from_all(abi),
            ))
        })
        .and_then(|r| r.add_rules(path_beneath_rules(&devices, AccessFs::from_all(abi))))
        .map_err(|e| format!("building the Landlock ruleset failed: {e}"))?;
    Ok(ruleset.into())
}

/// Prepare the launch of `program args` for a sidecar under `mode` and `policy`.
///
/// `off` and `audit` never change the launch. `enforce` uses the platform
/// backend; when the backend is unavailable on this host (a kernel without
/// Landlock, no `sandbox-exec`) the launch proceeds without filesystem
/// confinement and the returned status says so. An error means confinement was
/// available but could not be set up; callers fail the start in that case.
pub fn prepare(
    mode: IsolationMode,
    policy: &IsolationPolicy,
    program: &str,
    args: &[String],
) -> Result<PreparedIsolation, String> {
    let backend = IsolationBackend::for_platform();
    let mut prepared = PreparedIsolation {
        program: program.to_owned(),
        args: args.to_vec(),
        status: IsolationStatus {
            mode,
            backend: if mode == IsolationMode::Off {
                IsolationBackend::None
            } else {
                backend
            },
            enforced: false,
            fs_restricted: false,
            detail: None,
        },
        #[cfg(target_os = "linux")]
        landlock: None,
        #[cfg(target_os = "linux")]
        no_new_privs: false,
        #[cfg(windows)]
        memory_limit_mb: None,
    };
    match mode {
        IsolationMode::Off => return Ok(prepared),
        IsolationMode::Audit => {
            prepared.status.detail =
                Some("audit mode: policy computed and logged, nothing applied".to_owned());
            return Ok(prepared);
        }
        IsolationMode::Enforce => {}
    }

    #[cfg(target_os = "linux")]
    {
        prepared.no_new_privs = true;
        prepared.status.enforced = true;
        match landlock_abi_version() {
            Some(abi) => {
                prepared.landlock = build_landlock_ruleset(policy)?;
                prepared.status.fs_restricted = prepared.landlock.is_some();
                prepared.status.detail = Some(format!("Landlock ABI v{abi}; no_new_privs set"));
            }
            None => {
                prepared.status.detail = Some(
                    "Landlock is not available on this kernel: no filesystem restriction applied \
                     (no_new_privs is still set)"
                        .to_owned(),
                );
            }
        }
    }

    #[cfg(target_os = "macos")]
    {
        if Path::new(SANDBOX_EXEC).exists() {
            let profile = seatbelt_profile(policy);
            let mut wrapped = vec!["-p".to_owned(), profile, program.to_owned()];
            wrapped.extend(args.iter().cloned());
            prepared.program = SANDBOX_EXEC.to_owned();
            prepared.args = wrapped;
            prepared.status.enforced = true;
            prepared.status.fs_restricted = true;
        } else {
            prepared.status.detail = Some(format!(
                "{SANDBOX_EXEC} is missing: no filesystem restriction applied"
            ));
        }
    }

    #[cfg(windows)]
    {
        prepared.memory_limit_mb = policy.memory_limit_mb;
        prepared.status.enforced = true;
        prepared.status.detail = Some(
            "Job Object (kill on close, optional memory cap); Windows has no filesystem restriction"
                .to_owned(),
        );
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
    {
        let _ = policy;
        prepared.status.detail = Some("no OS isolation backend on this platform".to_owned());
    }

    Ok(prepared)
}

// ── Windows Job Object ──────────────────────────────────────────────────────

/// Owns a Job Object configured with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`:
/// dropping it (Core stopping the sidecar, or Core itself exiting) terminates
/// every process in the job.
#[cfg(windows)]
#[derive(Debug)]
pub struct JobGuard(windows_sys::Win32::Foundation::HANDLE);

// SAFETY: a Job Object handle is a process-wide kernel handle with no thread
// affinity; it is only closed once, in `Drop`.
#[cfg(windows)]
unsafe impl Send for JobGuard {}
#[cfg(windows)]
unsafe impl Sync for JobGuard {}

#[cfg(windows)]
impl JobGuard {
    fn assign(
        process: std::os::windows::io::RawHandle,
        memory_limit_mb: Option<u64>,
    ) -> std::io::Result<Self> {
        use std::mem::{size_of, zeroed};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_JOB_MEMORY, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        // SAFETY: plain Win32 calls on a handle this function owns; the limit
        // struct is zero-initialised as the API documents.
        unsafe {
            let job = CreateJobObjectW(std::ptr::null(), std::ptr::null());
            if job == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let guard = Self(job);
            let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = zeroed();
            limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            if let Some(mb) = memory_limit_mb {
                limits.BasicLimitInformation.LimitFlags |= JOB_OBJECT_LIMIT_JOB_MEMORY;
                limits.JobMemoryLimit =
                    usize::try_from(mb.saturating_mul(1024 * 1024)).unwrap_or(usize::MAX);
            }
            if SetInformationJobObject(
                guard.0,
                JobObjectExtendedLimitInformation,
                &limits as *const _ as *const _,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            ) == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            if AssignProcessToJobObject(guard.0, process as windows_sys::Win32::Foundation::HANDLE)
                == 0
            {
                return Err(std::io::Error::last_os_error());
            }
            Ok(guard)
        }
    }
}

#[cfg(windows)]
impl Drop for JobGuard {
    fn drop(&mut self) {
        // SAFETY: the handle was created by `assign` and is closed exactly once.
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.0);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use ryu_kernel_contracts::SidecarSandboxFs;

    struct Fixture {
        _dir: tempfile::TempDir,
        roots: IsolationRoots,
        system: PathBuf,
    }

    fn fixture() -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        let base = canonical(dir.path());
        let home = base.join("home");
        let ryu_dir = home.join(".ryu");
        let plugins_dir = ryu_dir.join("plugins");
        let app_data = plugins_dir.join("ryu-demo");
        let other = plugins_dir.join("ryu-other");
        let plugin_data = ryu_dir.join("plugin-data").join("ryu-demo");
        let other_data = ryu_dir.join("plugin-data").join("ryu-other");
        let temp = base.join("tmp");
        let system = base.join("usr");
        for d in [
            &app_data,
            &other,
            &plugin_data,
            &other_data,
            &temp,
            &system,
            &home.join(".cache/demo"),
        ] {
            std::fs::create_dir_all(d).expect("mkdir");
        }
        std::fs::create_dir_all(ryu_dir.join("mail-blobs")).expect("mkdir");
        Fixture {
            _dir: dir,
            roots: IsolationRoots {
                app_data,
                plugin_data,
                ryu_dir,
                plugins_dir,
                home: Some(home),
                temp,
            },
            system,
        }
    }

    fn declared(read: &[&str], write: &[&str]) -> SidecarSandboxSpec {
        SidecarSandboxSpec {
            fs: SidecarSandboxFs {
                read: read.iter().map(|s| (*s).to_owned()).collect(),
                write: write.iter().map(|s| (*s).to_owned()).collect(),
            },
            ..SidecarSandboxSpec::default()
        }
    }

    #[test]
    fn default_policy_grants_own_data_temp_and_system_paths_only() {
        let f = fixture();
        let policy =
            derive_policy_with(None, &f.roots, None, std::slice::from_ref(&f.system)).unwrap();
        assert_eq!(
            policy.read_write,
            vec![
                f.roots.app_data.clone(),
                f.roots.plugin_data.clone(),
                f.roots.temp.clone()
            ]
        );
        assert_eq!(policy.read_only, vec![f.system.clone()]);
        assert_eq!(
            policy.protected,
            vec![f.roots.ryu_dir.clone(), f.roots.home.clone().unwrap()]
        );
        assert!(policy.notes.is_empty(), "{:?}", policy.notes);
    }

    #[test]
    fn placeholders_resolve_against_the_roots() {
        let f = fixture();
        let spec = declared(
            &["$HOME/.cache/demo"],
            &["$RYU_DIR/mail-blobs", "$APP_DATA/db"],
        );
        let policy = derive_policy_with(Some(&spec), &f.roots, None, &[]).unwrap();
        let home = f.roots.home.clone().unwrap();
        assert!(policy.read_only.contains(&home.join(".cache/demo")));
        assert!(policy
            .read_write
            .contains(&f.roots.ryu_dir.join("mail-blobs")));
        // A not-yet-existing path below the own dir is kept as written.
        assert!(policy.read_write.contains(&f.roots.app_data.join("db")));
    }

    #[test]
    fn traversal_relative_and_other_app_paths_are_refused() {
        let f = fixture();
        for bad in [
            "$APP_DATA/../ryu-other",
            "relative/dir",
            "/etc",
            "$RYU_DIR/plugins/ryu-other",
            "$HOME",
            "$HOME/.ryu",
            "$HOME/.ryu/plugins/ryu-other",
            "$RYU_DIR/plugin-data/ryu-other",
            "$HOME/.ryu/plugin-data/ryu-other",
            "$HOME/.ryu/plugin-data",
        ] {
            let spec = declared(&[bad], &[]);
            let err = derive_policy_with(Some(&spec), &f.roots, None, &[]);
            assert!(err.is_err(), "{bad} must be refused, got {err:?}");
        }
    }

    #[test]
    fn the_shared_models_directory_is_readable_when_present() {
        let f = fixture();
        let models = f.roots.ryu_dir.join("models");
        std::fs::create_dir_all(&models).unwrap();
        let policy = derive_policy_with(None, &f.roots, None, &[]).unwrap();
        assert!(policy.read_only.contains(&models));
        assert!(!policy.read_write.contains(&models));
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_cannot_smuggle_another_apps_data_directory_in() {
        let f = fixture();
        let home = f.roots.home.clone().unwrap();
        std::os::unix::fs::symlink(
            f.roots.ryu_dir.join("plugin-data/ryu-other"),
            home.join("innocent-data"),
        )
        .expect("symlink");
        let err = derive_policy_with(
            Some(&declared(&[], &["$HOME/innocent-data"])),
            &f.roots,
            None,
            &[],
        )
        .expect_err("another app's data dir must be refused");
        assert!(err.contains("another app's data directory"), "{err}");
    }

    #[cfg(unix)]
    #[test]
    fn a_symlink_cannot_smuggle_another_apps_directory_in() {
        let f = fixture();
        let home = f.roots.home.clone().unwrap();
        std::os::unix::fs::symlink(f.roots.plugins_dir.join("ryu-other"), home.join("innocent"))
            .expect("symlink");
        std::os::unix::fs::symlink("/etc", home.join("escape")).expect("symlink");
        for raw in ["$HOME/innocent", "$HOME/escape"] {
            let err = derive_policy_with(Some(&declared(&[], &[raw])), &f.roots, None, &[])
                .expect_err(raw);
            assert!(err.contains(raw), "{err}");
        }
    }

    #[test]
    fn install_dirs_never_widen_to_the_core_data_dir() {
        let f = fixture();
        // A managed binary in `<RYU_DIR>/bin`: its prefix would be RYU_DIR itself.
        let bin = f.roots.ryu_dir.join("bin");
        std::fs::create_dir_all(&bin).unwrap();
        let program = bin.join("ryu-demo");
        std::fs::write(&program, b"").unwrap();
        let policy = derive_policy_with(None, &f.roots, Some(&program), &[]).unwrap();
        assert!(policy.read_only.contains(&bin));
        assert!(!policy.read_only.contains(&f.roots.ryu_dir));
        assert!(policy.notes.iter().any(|n| n.contains("install directory")));
        assert_eq!(policy.program.as_deref(), Some(program.as_path()));
    }

    #[test]
    fn temp_containing_the_core_data_dir_is_not_granted() {
        let f = fixture();
        let roots = IsolationRoots {
            temp: f.roots.home.clone().unwrap(),
            ..f.roots.clone()
        };
        let policy = derive_policy_with(None, &roots, None, &[]).unwrap();
        assert_eq!(
            policy.read_write,
            vec![roots.app_data.clone(), roots.plugin_data.clone()]
        );
        assert!(policy.notes.iter().any(|n| n.starts_with("temp directory")));
    }

    #[test]
    fn mode_off_and_audit_do_not_wrap_the_launch() {
        let policy = IsolationPolicy::default();
        let args = vec!["--port".to_owned(), "9000".to_owned()];
        for mode in [IsolationMode::Off, IsolationMode::Audit] {
            let prepared = prepare(mode, &policy, "ryu-demo", &args).unwrap();
            assert_eq!(prepared.program(), "ryu-demo");
            assert_eq!(prepared.args(), args.as_slice());
            assert!(!prepared.is_active());
            assert!(!prepared.status().enforced);
            assert!(!prepared.status().fs_restricted);
            #[cfg(target_os = "linux")]
            assert!(prepared.landlock.is_none());
        }
        assert_eq!(
            prepare(IsolationMode::Off, &policy, "x", &[])
                .unwrap()
                .status(),
            &IsolationStatus::off()
        );
    }

    #[test]
    fn seatbelt_profile_snapshot() {
        let policy = IsolationPolicy {
            read_only: vec![PathBuf::from("/usr"), PathBuf::from("/opt/homebrew/bin")],
            read_write: vec![
                PathBuf::from("/Users/a/.ryu/plugins/ryu-demo"),
                PathBuf::from("/private/var/folders/x/T"),
            ],
            protected: vec![PathBuf::from("/Users/a/.ryu"), PathBuf::from("/Users/a")],
            program: Some(PathBuf::from("/opt/homebrew/bin/ry\"u")),
            memory_limit_mb: None,
            notes: vec![],
        };
        let expected = r#"(version 1)
(allow default)
(deny file-write*)
(allow file-write*
    (subpath "/Users/a/.ryu/plugins/ryu-demo")
    (subpath "/private/var/folders/x/T")
    (literal "/dev/null")
    (literal "/dev/zero")
    (literal "/dev/tty")
    (literal "/dev/dtracehelper")
    (subpath "/dev/fd")
)
(deny file-read*
    (subpath "/Users/a/.ryu")
    (subpath "/Users/a")
)
(allow file-read-metadata
    (subpath "/Users/a/.ryu")
    (subpath "/Users/a")
)
(allow file-read*
    (subpath "/usr")
    (subpath "/opt/homebrew/bin")
    (subpath "/Users/a/.ryu/plugins/ryu-demo")
    (subpath "/private/var/folders/x/T")
)
(deny process-exec*)
(allow process-exec*
    (literal "/opt/homebrew/bin/ry\"u")
    (subpath "/usr")
    (subpath "/opt/homebrew/bin")
    (subpath "/Users/a/.ryu/plugins/ryu-demo")
)
"#;
        assert_eq!(seatbelt_profile(&policy), expected);
    }

    /// End-to-end Landlock enforcement: a `/bin/sh` child spawned under the
    /// derived policy can write in its own data dir and the temp dir, and gets
    /// EACCES ("Permission denied") everywhere else. Landlock confines root too,
    /// so this holds when the test runs as root.
    #[cfg(target_os = "linux")]
    #[tokio::test]
    async fn landlock_enforce_blocks_writes_outside_the_policy() {
        let Some(abi) = landlock_abi_version() else {
            eprintln!(
                "SKIPPED landlock_enforce_blocks_writes_outside_the_policy: \
                 Landlock is not available on this kernel"
            );
            return;
        };
        let f = fixture();
        let outside = tempfile::tempdir().expect("tempdir");
        let policy = derive_policy(None, &f.roots, Some(Path::new("/bin/sh"))).unwrap();
        let script = r#"
            echo ok > "$1/own.txt" && echo OWN_OK
            echo ok > "$2/tmp.txt" && echo TMP_OK
            echo no > "$3/escape.txt" 2>/dev/null || echo OUTSIDE_DENIED
            echo no > "$4/other.txt" 2>/dev/null || echo OTHER_APP_DENIED
            cat "$5" >/dev/null 2>&1 || echo CORE_READ_DENIED
            echo ok > "$6/own-data.txt" && echo OWN_DATA_OK
            echo no > "$7/other-data.txt" 2>/dev/null || echo OTHER_DATA_DENIED
            echo no 2>&1 > "$3/escape2.txt" | cat
        "#;
        std::fs::write(f.roots.ryu_dir.join("secret.db"), b"secret").unwrap();
        let args: Vec<String> = [
            "-c",
            script,
            "sh",
            &f.roots.app_data.to_string_lossy(),
            &f.roots.temp.to_string_lossy(),
            &outside.path().to_string_lossy(),
            &f.roots.plugins_dir.join("ryu-other").to_string_lossy(),
            &f.roots.ryu_dir.join("secret.db").to_string_lossy(),
            &f.roots.plugin_data.to_string_lossy(),
            &f.roots
                .ryu_dir
                .join("plugin-data/ryu-other")
                .to_string_lossy(),
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        let prepared = prepare(IsolationMode::Enforce, &policy, "/bin/sh", &args).unwrap();
        assert!(prepared.status().enforced);
        assert!(
            prepared.status().fs_restricted,
            "ABI v{abi}: {:?}",
            prepared.status()
        );
        let mut command = tokio::process::Command::new(prepared.program());
        command.args(prepared.args());
        prepared.install_pre_exec(&mut command);
        let output = command.output().await.expect("spawn sandboxed sh");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        for marker in [
            "OWN_OK",
            "TMP_OK",
            "OUTSIDE_DENIED",
            "OTHER_APP_DENIED",
            "CORE_READ_DENIED",
            "OWN_DATA_OK",
            "OTHER_DATA_DENIED",
        ] {
            assert!(
                stdout.contains(marker),
                "missing {marker}\nstdout: {stdout}\nstderr: {stderr}"
            );
        }
        assert!(
            stderr.contains("Permission denied") || stdout.contains("Permission denied"),
            "a denied write must fail with EACCES\nstdout: {stdout}\nstderr: {stderr}"
        );
        assert!(f.roots.app_data.join("own.txt").exists());
        assert!(f.roots.temp.join("tmp.txt").exists());
        assert!(!outside.path().join("escape.txt").exists());
        assert!(!outside.path().join("escape2.txt").exists());
        assert!(!f.roots.plugins_dir.join("ryu-other/other.txt").exists());
    }

    #[test]
    fn status_serializes_with_stable_field_names() {
        let status = IsolationStatus {
            mode: IsolationMode::Enforce,
            backend: IsolationBackend::JobObject,
            enforced: true,
            fs_restricted: false,
            detail: None,
        };
        assert_eq!(
            serde_json::to_value(&status).unwrap(),
            serde_json::json!({
                "mode": "enforce",
                "backend": "job_object",
                "enforced": true,
                "fs_restricted": false
            })
        );
    }
}
