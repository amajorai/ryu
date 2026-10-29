use super::*;

/// Whether this host can apply the untrusted-workspace profile, and if not,
/// why. Cached for the process: the answer depends on kernel/OS settings that
/// do not change while Core runs.
pub fn untrusted_support() -> Result<(), String> {
    static SUPPORT: std::sync::OnceLock<Result<(), String>> = std::sync::OnceLock::new();
    SUPPORT.get_or_init(probe_untrusted_support).clone()
}

#[cfg(target_os = "linux")]
fn probe_untrusted_support() -> Result<(), String> {
    // Namespaces can only be created from a single-threaded process, and Core
    // is not one; probe in a fresh runner process instead of guessing from
    // sysctls (AppArmor userns restrictions only show up when tried).
    let exe = std::env::current_exe().map_err(|error| error.to_string())?;
    let output = std::process::Command::new(exe)
        .arg(AGENT_SANDBOX_PROBE_ARG)
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|error| format!("could not start the sandbox probe: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        let detail = String::from_utf8_lossy(&output.stderr).trim().to_owned();
        Err(if detail.is_empty() {
            "unprivileged user namespaces are not available".to_owned()
        } else {
            detail
        })
    }
}

#[cfg(target_os = "macos")]
fn probe_untrusted_support() -> Result<(), String> {
    if is_executable(Path::new("/usr/bin/sandbox-exec")) {
        Ok(())
    } else {
        Err("/usr/bin/sandbox-exec is not available".to_owned())
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos")))]
fn probe_untrusted_support() -> Result<(), String> {
    Err("this OS has no agent sandbox runner yet".to_owned())
}

/// Launch `stdio` under `profile` (the untrusted-workspace profile, the
/// account-access profile, or both merged). A stdio already routed through the
/// runner (managed Codex) keeps its deletion denial and gains the profile; any
/// other agent is wrapped with deletion denial off.
pub fn confine_stdio(
    mut stdio: McpServerStdio,
    profile: &UntrustedProfile,
    relay_dir: Option<&Path>,
) -> Result<McpServerStdio> {
    untrusted_support().map_err(anyhow::Error::msg)?;
    let mut options = Vec::new();
    for mask in &profile.masks {
        options.push(OPT_MASK.to_owned());
        options.push(mask.to_string_lossy().into_owned());
    }
    if profile.deny_keychain {
        options.push(OPT_DENY_KEYCHAIN.to_owned());
    }
    if let Some(ports) = &profile.loopback_ports {
        options.push(OPT_ISOLATE_NETWORK.to_owned());
        for port in ports {
            options.push(OPT_LOOPBACK_PORT.to_owned());
            options.push(port.to_string());
        }
        if !ports.is_empty() {
            let Some(relay_dir) = relay_dir else {
                bail!("relayed loopback ports need a relay directory");
            };
            options.push(OPT_RELAY_DIR.to_owned());
            options.push(relay_dir.to_string_lossy().into_owned());
        }
    }

    let already_wrapped = stdio.args.first().map(String::as_str) == Some(AGENT_SANDBOX_RUNNER_ARG);
    if already_wrapped {
        stdio.args.splice(1..1, options);
        return Ok(stdio);
    }
    let runner = std::env::current_exe().context("resolving the Ryu agent runner")?;
    let original_command = std::mem::replace(&mut stdio.command, runner);
    let original_args = std::mem::take(&mut stdio.args);
    let mut runner_args = Vec::with_capacity(original_args.len() + options.len() + 4);
    runner_args.push(AGENT_SANDBOX_RUNNER_ARG.to_owned());
    runner_args.push(OPT_ALLOW_DELETE.to_owned());
    runner_args.extend(options);
    runner_args.push(ARG_SEPARATOR.to_owned());
    runner_args.push(original_command.to_string_lossy().into_owned());
    runner_args.extend(original_args);
    stdio.args = runner_args;
    Ok(stdio)
}

/// The runner's parsed command line.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct RunnerPlan {
    pub(super) deny_delete: bool,
    pub(super) masks: Vec<PathBuf>,
    pub(super) deny_keychain: bool,
    pub(super) isolate_network: bool,
    pub(super) loopback_ports: Vec<u16>,
    pub(super) relay_dir: Option<PathBuf>,
    pub(super) command: String,
    pub(super) args: Vec<String>,
}

pub(super) fn parse_runner_args(args: &[String]) -> Result<RunnerPlan> {
    let mut plan = RunnerPlan {
        deny_delete: true,
        ..RunnerPlan::default()
    };
    let mut index = 0;
    loop {
        let Some(option) = args.get(index) else {
            bail!("runner arguments must contain '{ARG_SEPARATOR}'")
        };
        index += 1;
        match option.as_str() {
            ARG_SEPARATOR => break,
            OPT_ALLOW_DELETE => plan.deny_delete = false,
            OPT_DENY_KEYCHAIN => plan.deny_keychain = true,
            OPT_ISOLATE_NETWORK => plan.isolate_network = true,
            OPT_MASK | OPT_LOOPBACK_PORT | OPT_RELAY_DIR => {
                let Some(value) = args.get(index) else {
                    bail!("runner option {option} needs a value")
                };
                index += 1;
                match option.as_str() {
                    OPT_MASK => plan.masks.push(PathBuf::from(value)),
                    OPT_LOOPBACK_PORT => plan.loopback_ports.push(
                        value
                            .parse()
                            .with_context(|| format!("invalid loopback port {value:?}"))?,
                    ),
                    _ => plan.relay_dir = Some(PathBuf::from(value)),
                }
            }
            other => bail!("unknown runner option {other:?}"),
        }
    }
    let Some(command) = args.get(index) else {
        bail!("runner received no child command")
    };
    plan.command = command.clone();
    plan.args = args[index + 1..].to_vec();
    if !plan.loopback_ports.is_empty() && plan.relay_dir.is_none() {
        bail!("relayed loopback ports need {OPT_RELAY_DIR}")
    }
    Ok(plan)
}

/// Run the Ryu Core binary as the ACP child runner (or the sandbox probe) when
/// its marker argument is present. Call this from `main` BEFORE the async
/// runtime starts: Linux namespaces can only be entered by a single-threaded
/// process. It does not open any database, start a server, or run agent code
/// outside the OS boundary.
pub fn run_if_requested() -> bool {
    let args = std::env::args().collect::<Vec<_>>();
    if args.iter().any(|arg| arg == AGENT_SANDBOX_PROBE_ARG) {
        let code = match run_probe() {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("{error:#}");
                1
            }
        };
        std::process::exit(code);
    }
    let Some(marker_index) = args.iter().position(|arg| arg == AGENT_SANDBOX_RUNNER_ARG) else {
        return false;
    };

    if let Err(error) = run_child(&args[marker_index + 1..]) {
        eprintln!("ryu agent sandbox runner refused to start: {error:#}");
        std::process::exit(126);
    }
    unreachable!("agent sandbox runner returned without replacing the process")
}

#[cfg(target_os = "linux")]
fn run_probe() -> Result<()> {
    // A fixed scratch directory: once masked it is a mount point inside the
    // probe's namespace and cannot be removed from there.
    // SAFETY: getuid has no preconditions.
    let uid = unsafe { libc::getuid() };
    let scratch = std::env::temp_dir().join(format!("ryu-sandbox-probe-{uid}"));
    std::fs::create_dir_all(&scratch).context("creating the probe directory")?;
    let plan = RunnerPlan {
        masks: vec![scratch],
        isolate_network: true,
        ..RunnerPlan::default()
    };
    linux::enter(&plan)
}

#[cfg(not(target_os = "linux"))]
fn run_probe() -> Result<()> {
    probe_untrusted_support().map_err(anyhow::Error::msg)
}

fn run_child(args: &[String]) -> Result<()> {
    let plan = parse_runner_args(args)?;

    // `plan.deny_keychain` is macOS-only: Linux has no Keychain daemon, and
    // its Secret Service is reached over D-Bus, which this runner does not cut.
    #[cfg(target_os = "linux")]
    {
        if !plan.masks.is_empty() || plan.isolate_network {
            linux::enter(&plan)?;
        }
        if plan.deny_delete {
            install_linux_delete_denial()?;
        }
        use std::os::unix::process::CommandExt;
        let error = std::process::Command::new(&plan.command)
            .args(&plan.args)
            .exec();
        return Err(error).context("execing the confined agent");
    }

    #[cfg(target_os = "macos")]
    {
        use std::os::unix::process::CommandExt;
        let profile = seatbelt_profile(&plan);
        let error = std::process::Command::new("/usr/bin/sandbox-exec")
            .arg("-p")
            .arg(profile)
            .arg(&plan.command)
            .args(&plan.args)
            .exec();
        return Err(error).context("execing the macOS Seatbelt agent child");
    }

    #[cfg(target_os = "windows")]
    {
        let _ = plan;
        bail!("native Windows AppContainer containment is not available in this build")
    }

    #[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
    {
        let _ = plan;
        bail!("this OS has no verified agent containment runner")
    }
}

/// Quote a path for a Seatbelt (SBPL) string literal.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(super) fn seatbelt_string(path: &Path) -> String {
    let text = path.to_string_lossy();
    let mut quoted = String::with_capacity(text.len() + 2);
    quoted.push('"');
    for character in text.chars() {
        if matches!(character, '"' | '\\') {
            quoted.push('\\');
        }
        quoted.push(character);
    }
    quoted.push('"');
    quoted
}

/// The Seatbelt profile for a runner plan: allow by default, then deny what
/// the plan confines. Seatbelt resolves `/private` firmlinks itself for
/// `subpath`, so home-relative paths match as given.
#[cfg_attr(not(any(target_os = "macos", test)), allow(dead_code))]
pub(super) fn seatbelt_profile(plan: &RunnerPlan) -> String {
    let mut profile = String::from("(version 1) (allow default)");
    if plan.deny_delete {
        profile.push_str(" (deny file-write-unlink)");
    }
    if !plan.masks.is_empty() {
        profile.push_str(" (deny file-read* file-write*");
        for mask in &plan.masks {
            let filter = if mask.is_dir() { "subpath" } else { "literal" };
            profile.push_str(&format!(" ({filter} {})", seatbelt_string(mask)));
        }
        profile.push(')');
    }
    if plan.deny_keychain {
        profile.push_str(" (deny mach-lookup");
        for service in KEYCHAIN_MACH_SERVICES {
            profile.push_str(&format!(
                " (global-name {})",
                seatbelt_string(Path::new(service))
            ));
        }
        profile.push(')');
    }
    if plan.isolate_network {
        profile.push_str(
            " (deny network-outbound) (allow network-outbound (remote ip \"localhost:*\")) \
             (allow network-outbound (remote unix-socket))",
        );
    }
    profile
}

#[cfg(target_os = "linux")]
fn install_linux_delete_denial() -> Result<()> {
    // Landlock syscall numbers are stable in the asm-generic syscall table used
    // by supported Linux architectures. This ruleset handles only removal
    // rights and installs no path rules, so those rights are denied everywhere.
    const LANDLOCK_CREATE_RULESET: libc::c_long = 444;
    const LANDLOCK_RESTRICT_SELF: libc::c_long = 446;
    const LANDLOCK_ACCESS_FS_REMOVE_DIR: u64 = 1 << 4;
    const LANDLOCK_ACCESS_FS_REMOVE_FILE: u64 = 1 << 5;

    let no_new_privs = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if no_new_privs != 0 {
        return Err(std::io::Error::last_os_error()).context("enabling no_new_privs for Landlock");
    }

    #[repr(C)]
    struct RulesetAttr {
        handled_access_fs: u64,
    }
    let attr = RulesetAttr {
        handled_access_fs: LANDLOCK_ACCESS_FS_REMOVE_DIR | LANDLOCK_ACCESS_FS_REMOVE_FILE,
    };
    let fd = unsafe {
        libc::syscall(
            LANDLOCK_CREATE_RULESET,
            &attr as *const RulesetAttr,
            std::mem::size_of::<RulesetAttr>(),
            0,
        )
    };
    if fd < 0 {
        return Err(std::io::Error::last_os_error())
            .context("creating the Landlock deletion-denial ruleset");
    }

    let restricted = unsafe { libc::syscall(LANDLOCK_RESTRICT_SELF, fd, 0) };
    let restrict_error = if restricted != 0 {
        Some(std::io::Error::last_os_error())
    } else {
        None
    };
    unsafe {
        libc::close(fd as libc::c_int);
    }
    if let Some(error) = restrict_error {
        return Err(error).context("installing the Landlock deletion-denial ruleset");
    }
    Ok(())
}
