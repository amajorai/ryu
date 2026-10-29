use std::path::Path;

/// Whether a launch of `program` with `args` runs Gemini CLI: its own `gemini`
/// binary (as the program, or as a script path handed to a runtime such as
/// `node`) or its npm package (`npx @google/gemini-cli`, or the installed
/// `node …/@google/gemini-cli/…`). The account sandbox keeps `~/.gemini` and
/// the account-access launch check requires `provider:genai` on this same
/// match, so the two can never disagree.
pub fn launches_gemini_cli<'a>(program: &Path, args: impl IntoIterator<Item = &'a str>) -> bool {
    let is_gemini_binary = |path: &Path| {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| stem.eq_ignore_ascii_case("gemini"))
    };
    is_gemini_binary(program)
        || args.into_iter().any(|word| {
            word.to_ascii_lowercase().contains("@google/gemini-cli")
                || ((word.contains('/') || word.contains('\\'))
                    && is_gemini_binary(Path::new(word)))
        })
}

/// The npm packages of Claude Code's ACP adapter, by scope and name.
const CLAUDE_CODE_ACP_PACKAGES: &[(&str, &str)] = &[
    ("@agentclientprotocol", "claude-agent-acp"),
    ("@zed-industries", "claude-code-acp"),
];

/// Whether a launch of `program` with `args` runs Claude Code's ACP adapter
/// itself, not some other program whose command line mentions it: the
/// adapter's own binary as the program (`claude-agent-acp`, with any
/// extension), its npm package spec as a whole word (`npx -y
/// @agentclientprotocol/claude-agent-acp@latest`, also behind `cmd /c`), or
/// `node` running a script inside that installed package. A shell, wrapper
/// script or any other program that merely names the adapter does not count.
/// The account sandbox lets only this launch keep the user's Keychain.
pub fn launches_claude_code_acp<'a>(
    program: &Path,
    args: impl IntoIterator<Item = &'a str>,
) -> bool {
    let stem = |path: &Path| {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .map(str::to_ascii_lowercase)
    };
    let program_stem = stem(program);
    if program_stem.as_deref().is_some_and(|stem| {
        CLAUDE_CODE_ACP_PACKAGES
            .iter()
            .any(|(_, name)| *name == stem)
    }) {
        return true;
    }
    let is_package_spec = |word: &str| {
        let word = word.to_ascii_lowercase();
        CLAUDE_CODE_ACP_PACKAGES.iter().any(|(scope, name)| {
            word.strip_prefix(scope)
                .and_then(|rest| rest.strip_prefix('/'))
                .and_then(|rest| rest.strip_prefix(name))
                .is_some_and(|version| version.is_empty() || version.starts_with('@'))
        })
    };
    let is_package_script = |word: &str| {
        let parts: Vec<String> = word
            .split(['/', '\\'])
            .map(str::to_ascii_lowercase)
            .collect();
        parts.windows(3).any(|window| {
            window[0] == "node_modules"
                && CLAUDE_CODE_ACP_PACKAGES
                    .iter()
                    .any(|(scope, name)| window[1] == *scope && window[2] == *name)
        })
    };
    // `npx` runs the first word that is not an option.
    let npx_runs_adapter = |args: &[&str]| {
        args.iter()
            .find(|word| !word.starts_with('-'))
            .is_some_and(|word| is_package_spec(word))
    };
    let args: Vec<&str> = args.into_iter().collect();
    match program_stem.as_deref().unwrap_or_default() {
        "npx" | "bunx" | "pnpx" => npx_runs_adapter(&args),
        // Windows: `cmd /c [set NAME=value&&] npx …`.
        "cmd" => args
            .iter()
            .position(|word| {
                Path::new(word)
                    .file_stem()
                    .is_some_and(|stem| stem.eq_ignore_ascii_case("npx"))
                    || word.to_ascii_lowercase().ends_with("&&npx")
            })
            .is_some_and(|index| npx_runs_adapter(&args[index + 1..])),
        "node" => args.first().is_some_and(|script| is_package_script(script)),
        _ => false,
    }
}

/// [`launches_claude_code_acp`] for a parsed stdio declaration.
pub fn stdio_launches_claude_code_acp(
    stdio: &agent_client_protocol::schema::v1::McpServerStdio,
) -> bool {
    launches_claude_code_acp(&stdio.command, stdio.args.iter().map(String::as_str))
}

/// Whether a launch of `program` runs the Kiro CLI (`kiro-cli`), by its
/// binary or a script path handed to a runtime.
pub fn launches_kiro_cli<'a>(program: &Path, args: impl IntoIterator<Item = &'a str>) -> bool {
    let is_kiro_binary = |path: &Path| {
        path.file_stem()
            .and_then(|stem| stem.to_str())
            .is_some_and(|stem| stem.eq_ignore_ascii_case("kiro-cli"))
    };
    is_kiro_binary(program)
        || args.into_iter().any(|word| {
            (word.contains('/') || word.contains('\\')) && is_kiro_binary(Path::new(word))
        })
}

/// Split a custom `acp-exec:` spawn command into program and arguments the
/// way the launcher does (shell words), falling back to whitespace when the
/// quoting is malformed.
fn split_spawn(spawn_cmd: &str) -> Vec<String> {
    shell_words::split(spawn_cmd)
        .unwrap_or_else(|_| spawn_cmd.split_whitespace().map(str::to_owned).collect())
}

/// [`launches_gemini_cli`] for a custom `acp-exec:` spawn command.
pub fn spawn_launches_gemini_cli(spawn_cmd: &str) -> bool {
    let words = split_spawn(spawn_cmd);
    let Some((program, args)) = words.split_first() else {
        return false;
    };
    launches_gemini_cli(Path::new(program), args.iter().map(String::as_str))
}

/// [`launches_kiro_cli`] for a custom `acp-exec:` spawn command.
pub fn spawn_launches_kiro_cli(spawn_cmd: &str) -> bool {
    let words = split_spawn(spawn_cmd);
    let Some((program, args)) = words.split_first() else {
        return false;
    };
    launches_kiro_cli(Path::new(program), args.iter().map(String::as_str))
}
