use super::*;

/// The program a stdio launches and its arguments, looking through Ryu's
/// sandbox runner.
fn launched_program(stdio: &McpServerStdio) -> (&str, &[String]) {
    if stdio.args.first().map(String::as_str)
        == Some(crate::agent_sandbox::AGENT_SANDBOX_RUNNER_ARG)
    {
        if let Some(separator) = stdio.args.iter().position(|arg| arg == "--") {
            if let Some(program) = stdio.args.get(separator + 1) {
                return (program, &stdio.args[separator + 2..]);
            }
        }
    }
    (stdio.command.to_str().unwrap_or_default(), &stdio.args)
}

/// Whether the agent is started through a package runner (`npx`, `bunx`,
/// `pnpm dlx`, `yarn dlx`, `uvx`, `pipx run`, `bun x`, `uv tool run`,
/// `corepack`, `deno run npm:…`, …) that resolves and downloads code from a
/// registry when it starts. Such a launch needs the open network before the
/// agent's own traffic can be routed anywhere, so it cannot run under the
/// untrusted-workspace network cut. Looks through Ryu's sandbox runner, `env`,
/// and a shell's `-c` / `cmd /c` command line, so a wrapped runner is still
/// recognised.
pub(super) fn launch_downloads_agent(stdio: &McpServerStdio) -> bool {
    let (program, args) = launched_program(stdio);
    command_downloads_code(program, args, 0)
}

/// Programs that resolve and download a package whenever they start one.
const PACKAGE_RUNNERS: &[&str] = &[
    "npx", "bunx", "pnpx", "uvx", "pipx", "npm", "pnpm", "yarn", "corepack",
];

/// Shells whose command line (`-c …`, `cmd /c …`, `pwsh -Command …`) is looked
/// through for a package runner.
const SHELLS: &[&str] = &[
    "sh",
    "bash",
    "zsh",
    "dash",
    "ksh",
    "fish",
    "cmd",
    "powershell",
    "pwsh",
];

/// Prefixes that run the rest of their command line unchanged.
const TRANSPARENT_PREFIXES: &[&str] = &["exec", "command", "nohup", "call", "time"];

/// How many wrappers deep a launch is looked through before it is treated as a
/// package runner (fail closed).
const MAX_LAUNCH_WRAPPER_DEPTH: usize = 6;

/// The bare, lowercase program name: no directory, no Windows launcher
/// extension (`NPX.CMD`, `npx.ps1`, `bunx.exe` all name the runner).
fn launched_program_name(program: &str) -> String {
    let base = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or(program)
        .to_ascii_lowercase();
    for extension in [".exe", ".cmd", ".bat", ".ps1"] {
        if let Some(stem) = base.strip_suffix(extension) {
            return stem.to_owned();
        }
    }
    base
}

fn command_downloads_code(program: &str, args: &[String], depth: usize) -> bool {
    if depth > MAX_LAUNCH_WRAPPER_DEPTH {
        return true;
    }
    let name = launched_program_name(program);
    let first_operand = || {
        args.iter()
            .map(String::as_str)
            .find(|arg| !arg.starts_with('-'))
    };
    match name.as_str() {
        runner if PACKAGE_RUNNERS.contains(&runner) => true,
        "bun" => first_operand() == Some("x"),
        "uv" => first_operand() == Some("tool"),
        "deno" => {
            first_operand() == Some("x")
                || args.iter().any(|arg| {
                    let arg = arg.to_ascii_lowercase();
                    ["npm:", "jsr:", "http://", "https://"]
                        .iter()
                        .any(|scheme| {
                            arg.starts_with(scheme) || arg.contains(&format!("={scheme}"))
                        })
                })
        }
        "env" => env_command_downloads_code(args, depth),
        prefix if TRANSPARENT_PREFIXES.contains(&prefix) => {
            let rest: Vec<String> = args
                .iter()
                .skip_while(|arg| arg.starts_with('-'))
                .cloned()
                .collect();
            tokens_download_code(&rest, depth + 1)
        }
        shell if SHELLS.contains(&shell) => shell_script(&name, args)
            .is_some_and(|script| script_downloads_code(&script, depth + 1)),
        _ => false,
    }
}

/// `env [-i] [-u NAME] [-C DIR] [NAME=VALUE]… program args…`, or
/// `env -S "program args…"`.
fn env_command_downloads_code(args: &[String], depth: usize) -> bool {
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        match arg.as_str() {
            "-S" | "--split-string" => {
                return args
                    .get(index + 1)
                    .is_some_and(|script| script_downloads_code(script, depth + 1));
            }
            "-u" | "--unset" | "-C" | "--chdir" => index += 2,
            "--" => {
                index += 1;
                break;
            }
            flag if flag.starts_with("-S") => {
                return script_downloads_code(&flag[2..], depth + 1);
            }
            flag if flag.starts_with('-') => index += 1,
            assignment if assignment.contains('=') => index += 1,
            _ => break,
        }
    }
    tokens_download_code(args.get(index..).unwrap_or_default(), depth + 1)
}

/// The command line a shell is asked to run, if it is given one inline.
fn shell_script(shell: &str, args: &[String]) -> Option<String> {
    let position = args.iter().position(|arg| match shell {
        "cmd" => arg.eq_ignore_ascii_case("/c") || arg.eq_ignore_ascii_case("/k"),
        "powershell" | "pwsh" => {
            let lower = arg.to_ascii_lowercase();
            lower == "-c" || lower == "-command" || lower == "/c" || lower == "/command"
        }
        _ => {
            arg.len() > 1
                && arg.starts_with('-')
                && !arg.starts_with("--")
                && arg[1..].contains('c')
        }
    })?;
    let rest = &args[position + 1..];
    match shell {
        // cmd and PowerShell run everything after the switch as one line.
        "cmd" | "powershell" | "pwsh" => Some(rest.join(" ")),
        _ => rest.first().cloned(),
    }
}

/// Whether any simple command in a shell command line starts a package runner.
fn script_downloads_code(script: &str, depth: usize) -> bool {
    if depth > MAX_LAUNCH_WRAPPER_DEPTH {
        return true;
    }
    script
        .split(['\n', ';', '|', '&', '(', ')', '`'])
        .map(|segment| segment.trim().trim_start_matches("$("))
        .filter(|segment| !segment.is_empty())
        .any(|segment| {
            let tokens = shell_words::split(segment).unwrap_or_else(|_| {
                segment
                    .split_whitespace()
                    .map(|token| token.trim_matches(['"', '\'']).to_owned())
                    .collect()
            });
            tokens_download_code(&tokens, depth)
        })
}

/// A tokenized simple command, after leading `NAME=VALUE` assignments.
fn tokens_download_code(tokens: &[String], depth: usize) -> bool {
    let start = tokens
        .iter()
        .position(|token| !token.contains('=') || token.starts_with('-') || token.starts_with('='))
        .unwrap_or(tokens.len());
    let Some(program) = tokens.get(start) else {
        return false;
    };
    // cmd's `set NAME=VALUE` is an assignment, not a program.
    if program.eq_ignore_ascii_case("set") {
        return false;
    }
    command_downloads_code(program, &tokens[start + 1..], depth)
}

/// The refusal for an agent that a package runner would download into an
/// untrusted folder with the network open.
fn package_runner_refusal(stdio: &McpServerStdio) -> String {
    let (program, _) = launched_program(stdio);
    let runner = program.rsplit(['/', '\\']).next().unwrap_or(program);
    format!(
        "Ryu did not start this agent: its launch (`{runner}`) goes through a package runner, \
         which downloads code when it starts, so Ryu cannot cut its network access in a folder you have not trusted. \
         Ryu installs npm agents in the background so they can start sandboxed; send your \
         message again once that finishes. Otherwise, trust this folder if you trust its code, or open the chat in a \
         trusted folder."
    )
}

/// The TCP port of a loopback URL (`http://127.0.0.1:7981`), if it is one.
pub(super) fn loopback_port(url: &str) -> Option<u16> {
    let url = reqwest::Url::parse(url).ok()?;
    let loopback = match url.host()? {
        url::Host::Domain(domain) => domain.eq_ignore_ascii_case("localhost"),
        url::Host::Ipv4(address) => address.is_loopback(),
        url::Host::Ipv6(address) => address.is_loopback(),
    };
    loopback.then(|| url.port_or_known_default()).flatten()
}

/// `Some(refusal)` when an agent about to spawn in an untrusted folder must not
/// start at all. A package-runner launch is refused: it needs the open network
/// to download itself, and leaving the network open would hand code from the
/// untrusted folder full network access for the whole session. npm agents stop
/// matching once [`super::acp_direct_spawn`] has installed them (they then
/// start as `node <bin>`), so the refusal clears on its own after that install.
pub(super) fn untrusted_launch_refusal(stdio: &McpServerStdio) -> Option<String> {
    launch_downloads_agent(stdio).then(|| package_runner_refusal(stdio))
}

/// The failed-turn frame for an untrusted-folder launch Ryu refused.
pub(super) fn untrusted_launch_failure(refusal: &str) -> AcpFailure {
    AcpFailure {
        code: "workspace_untrusted_launch".to_owned(),
        title: "Agent not started in an untrusted folder".to_owned(),
        message: refusal.to_owned(),
    }
}
