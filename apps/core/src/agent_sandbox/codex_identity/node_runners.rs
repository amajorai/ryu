use super::*;

/// Node running a Codex ACP entry: a `codex-acp` script, or any file inside a
/// vendor `codex-acp` package. Data directories do not count.
pub(super) fn node_entry_is_codex(script: &str) -> bool {
    let normalized = script.replace('\\', "/").to_ascii_lowercase();
    let components = normalized.split('/').collect::<Vec<_>>();
    if components.last().is_some_and(|name| {
        matches!(
            *name,
            "codex-acp" | "codex-acp.js" | "codex-acp.mjs" | "codex-acp.cjs"
        )
    }) {
        return true;
    }
    components.windows(3).any(|parts| {
        parts[0] == "node_modules"
            && matches!(parts[1], "@zed-industries" | "@agentclientprotocol")
            && parts[2] == "codex-acp"
    })
}

/// Node running a script, or a program given inline (`-e`, `-p`), read from
/// standard input (`-`, or no script at all), or named in package.json
/// (`--run`), which counts as Codex because it is not read here.
pub(super) fn node_launches_codex(args: &[String]) -> bool {
    let mut words = args.iter();
    let mut may_be_value = false;
    while let Some(word) = words.next() {
        let option = word
            .split_once('=')
            .map_or(word.as_str(), |(option, _)| option);
        if word == "-" || is_inline_program_option(word) || option == "--run" {
            return true;
        }
        if NODE_INFORMATION.contains(&option) {
            return false;
        }
        if word == "--" {
            return words
                .next()
                .is_some_and(|script| node_entry_is_codex(script) || is_dynamic(script));
        }
        if is_option(word) {
            may_be_value = !word.contains('=') && !NODE_SWITCHES.contains(&word.as_str());
            continue;
        }
        if node_entry_is_codex(word) || is_dynamic(word) {
            return true;
        }
        if !may_be_value {
            return false;
        }
        may_be_value = false;
    }
    // No script (or only words that may be option values): Node runs the
    // program on standard input.
    true
}

/// Node options that print information and run no program, or only check one.
pub(super) const NODE_INFORMATION: &[&str] = &[
    "-v",
    "--version",
    "-h",
    "--help",
    "--v8-options",
    "-c",
    "--check",
    "--completion-bash",
];

/// What a package-manager invocation runs.
pub(super) enum RunnerCall<'a> {
    /// Words the runner resolves to a package or bin.
    Operands(&'a [String]),
    /// A package.json script, whose body is not inspected.
    PackageScript,
    /// A file `bun` runs directly, as Node does.
    Entry(&'a str),
}

/// What a package runner runs, or `None` when `name` is not one (or runs
/// nothing). `pnpm`, `yarn` and `bun` run a script of a bare name when the
/// package defines one, else a bin of that name.
pub(super) fn runner_call<'a>(name: &str, args: &'a [String]) -> Option<RunnerCall<'a>> {
    if matches!(name, "npx" | "pnpx" | "bunx") {
        return Some(RunnerCall::Operands(args));
    }
    if !matches!(name, "npm" | "pnpm" | "yarn" | "bun") {
        return None;
    }
    let mut may_be_value = false;
    for (index, word) in args.iter().enumerate() {
        if is_option(word) {
            may_be_value = !word.contains('=');
            continue;
        }
        let subcommand = word.to_ascii_lowercase();
        if matches!(subcommand.as_str(), "exec" | "x") || (name != "npm" && subcommand == "dlx") {
            return Some(RunnerCall::Operands(&args[index + 1..]));
        }
        if name == "npm" {
            if NPM_SCRIPT_COMMANDS.contains(&subcommand.as_str()) {
                return Some(RunnerCall::PackageScript);
            }
            if !may_be_value {
                return None;
            }
        } else {
            if names_codex_package(word) {
                return Some(RunnerCall::Operands(&args[index..]));
            }
            if !may_be_value {
                if name == "bun" && looks_like_script_path(word) {
                    return Some(RunnerCall::Entry(word));
                }
                return Some(RunnerCall::PackageScript);
            }
        }
        may_be_value = false;
    }
    None
}

/// A file path rather than a script or bin name, for `bun <file>`.
pub(super) fn looks_like_script_path(word: &str) -> bool {
    word.contains(['/', '\\'])
        || [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".jsx", ".tsx"]
            .iter()
            .any(|extension| word.to_ascii_lowercase().ends_with(extension))
}

pub(super) fn runner_launches_codex(args: &[String], depth: usize) -> bool {
    let mut words = args.iter();
    let mut may_be_value = false;
    while let Some(word) = words.next() {
        if word == "--" {
            return words
                .next()
                .is_some_and(|operand| names_codex_package(operand));
        }
        if !is_option(word) {
            if names_codex_package(word) {
                return true;
            }
            if !may_be_value {
                return false;
            }
            may_be_value = false;
            continue;
        }
        let (option, inline) = match word.split_once('=') {
            Some((option, value)) => (option, Some(value.to_owned())),
            None => (word.as_str(), None),
        };
        may_be_value = false;
        match option {
            "-p" | "--package" => {
                let package = inline.or_else(|| words.next().cloned());
                if package.is_some_and(|package| names_codex_package(&package)) {
                    return true;
                }
            }
            // `npm exec -c` runs a command line through the platform shell.
            "-c" | "--call" => {
                let line = inline.or_else(|| words.next().cloned());
                if line.is_some_and(|line| command_line_launches_codex(&line, depth)) {
                    return true;
                }
            }
            _ => may_be_value = inline.is_none() && !RUNNER_SWITCHES.contains(&option),
        }
    }
    false
}

/// Whether a package-runner operand (a package spec or bin name) names Codex.
/// Git, URL, path and alias specs count when they name the ACP package.
pub(super) fn names_codex_package(operand: &str) -> bool {
    let lower = operand.to_ascii_lowercase();
    if lower.contains("codex-acp") || is_dynamic(operand) {
        return true;
    }
    // `alias@npm:@openai/codex@1` installs the aliased package.
    let spec = lower
        .rsplit_once("@npm:")
        .map_or(lower.as_str(), |(_, target)| target);
    crate::sidecar::adapters::acp_direct_spawn::package_name(spec)
        .is_some_and(|name| name.rsplit('/').next() == Some("codex"))
}
