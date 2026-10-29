//! Which ACP stdio declarations start Codex, and therefore take the runner.
//!
//! This classification is the only gate for Codex confinement on the ACP spawn
//! path, so it fails closed within the shapes it reads (listed below) and is
//! deliberately separate from the strict `npx -y <spec>` parser that launch
//! rewriting uses. It follows what would actually run:
//!
//! - the program itself: any program whose file name contains `codex` (the
//!   same rule the Codex launch-settings guard applies to a custom command), or
//!   Node/Bun running a vendor entry;
//! - a package runner (`npx`, `pnpx`, `bunx`, `npm exec|x`, `pnpm dlx`,
//!   `yarn dlx`, `bun x`, `deno run` with an `npm:` specifier, …) whatever its
//!   options, including `-p`/`--package` and `-c`/`--call`;
//! - every command a `cmd /c`, `sh -c`-style, `eval` or PowerShell `-Command`
//!   wrapper runs, including commands after `&`, `|`, `;`, inside `$(…)` and
//!   backticks, inside `{ … }`, `if`/`while` bodies, function bodies and
//!   `trap` actions, PowerShell script blocks, and the targets of shell and
//!   PowerShell aliases;
//! - the command a launcher runs: `exec`, `command`, `nohup`, `nice`, `time`,
//!   `timeout`, `sudo`, `doas`, `setsid`, `stdbuf`, `ionice`, `taskset`,
//!   `chrt`, `unbuffer`, `caffeinate`, `xargs`, `watch`, `script`, cmd.exe
//!   `start` and PowerShell `Start-Process`;
//! - `env -S`/`--split-string` strings, split as `env` splits them, and
//!   PowerShell `-EncodedCommand` scripts, decoded.
//!
//! An option that is not known to be a switch might take the next word as its
//! value, so both readings are checked. Words after the package or script the
//! runner resolved are agent input and never consulted.
//!
//! What cannot be read counts as Codex: a program or package that a shell
//! expands at launch (`$NAME`, `%NAME%`, `$(…)`) or that `xargs` reads from
//! standard input; a quote, `$(…)` or backtick substitution that is never
//! closed, and a `case` inside `$(…)`; a shell reading its commands from a
//! script file, a sourced file or standard input; a PowerShell `-File` script
//! or an encoded command that does not decode; inline interpreter code
//! (`python -c`, `node -e`/`-p`, `bun -e`, `deno eval`, `ruby -e`,
//! `perl -e`/`-E`) or a program read from standard input (`python -`,
//! `ruby -`, `perl -`); and a package.json or Deno task run by
//! `npm run`/`start`/`test`, `deno task`, or by `pnpm`, `yarn` or `bun` with a
//! script name.
//!
//! Any other program is identified by its own name, not by what it starts: a
//! script file run by an interpreter, a compiled launcher, or code that starts
//! a process itself (for example a PowerShell .NET call).

use std::collections::HashSet;

use agent_client_protocol::schema::v1::McpServerStdio;

mod env_launchers;
mod interpreters;
mod launched_commands;
mod node_runners;
mod posix_lex;
mod powershell_lex;
mod shells;

use env_launchers::*;
use interpreters::*;
use launched_commands::*;
use node_runners::*;
use posix_lex::*;
use powershell_lex::*;
use shells::*;

/// Nested shells (`sh -c "bash -c …"`) deeper than this count as Codex: Ryu
/// never declares them, and classification must fail closed.
const MAX_SHELL_DEPTH: usize = 4;

/// Package-runner options known to take no value.
const RUNNER_SWITCHES: &[&str] = &[
    "-y",
    "--yes",
    "--no",
    "--no-yes",
    "-q",
    "--quiet",
    "-s",
    "--silent",
    "--prefer-offline",
    "--prefer-online",
    "--offline",
    "--ignore-existing",
    "--no-install",
    "--workspaces",
    "--ws",
    "--include-workspace-root",
    "--bun",
    "--verbose",
    "-d",
];

/// Node options known to take no value.
const NODE_SWITCHES: &[&str] = &[
    "--enable-source-maps",
    "--no-warnings",
    "--no-deprecation",
    "--trace-warnings",
    "--trace-uncaught",
    "--expose-gc",
    "--inspect",
    "--inspect-brk",
    "--preserve-symlinks",
    "--preserve-symlinks-main",
    "--experimental-vm-modules",
];

/// npm subcommands (and their aliases) that run a package.json script.
const NPM_SCRIPT_COMMANDS: &[&str] = &[
    "run",
    "run-script",
    "rum",
    "urn",
    "start",
    "stop",
    "restart",
    "test",
    "tst",
    "t",
    "install-test",
    "it",
    "install-ci-test",
    "cit",
    "clean-install-test",
    "sit",
];

/// Whether this stdio declaration starts Codex. See the module documentation.
pub fn is_codex_stdio(stdio: &McpServerStdio) -> bool {
    let words = std::iter::once(stdio.command.to_string_lossy().into_owned())
        .chain(stdio.args.iter().cloned())
        .collect::<Vec<_>>();
    command_launches_codex(&words, 0)
}

/// Whether one simple command (program and arguments, already unquoted) starts Codex.
fn command_launches_codex(words: &[String], depth: usize) -> bool {
    // A launcher can be read more than one way, so every plausible command is
    // queued. Each is a suffix of `words`, which keeps the queue finite.
    let mut pending = vec![words];
    let mut seen = HashSet::new();
    while let Some(words) = pending.pop() {
        if !seen.insert((words.as_ptr() as usize, words.len())) {
            continue;
        }
        match simple_command(words, depth) {
            Step::Codex => return true,
            Step::Done => {}
            Step::Runs(commands) => pending.extend(commands),
        }
    }
    false
}

/// What one simple command does, as far as Codex is concerned.
enum Step<'a> {
    /// It starts Codex, or runs something that cannot be read.
    Codex,
    /// It cannot start Codex.
    Done,
    /// It runs one of these commands (every plausible reading of its words).
    Runs(Vec<&'a [String]>),
}

impl Step<'_> {
    fn found(codex: bool) -> Self {
        if codex {
            Self::Codex
        } else {
            Self::Done
        }
    }
}

fn simple_command(words: &[String], depth: usize) -> Step<'_> {
    let Some((program, args)) = words.split_first() else {
        return Step::Done;
    };
    if is_assignment(program) {
        return Step::Runs(vec![args]);
    }
    if is_dynamic(program) {
        return Step::Codex;
    }
    let name = program_name(program);
    if name.contains("codex") {
        return Step::Codex;
    }
    match name.as_str() {
        "node" | "nodejs" => return Step::found(node_launches_codex(args)),
        "deno" => return Step::found(deno_launches_codex(args)),
        "env" => return Step::found(env_launches_codex(args, depth)),
        // Reserved words and grouping run the command that follows them.
        "{" | "}" | "!" | "if" | "then" | "elif" | "else" | "fi" | "while" | "until" | "do"
        | "done" | "esac" | "coproc" => return Step::Runs(vec![args]),
        // `function name { … }` (POSIX shells and PowerShell): skip the name.
        "function" | "filter" => return Step::Runs(vec![args.get(1..).unwrap_or_default()]),
        // Loop and case headers hold a variable and data, not a command.
        "for" | "select" | "case" | "foreach" => return Step::Done,
        // A sourced file runs in this shell, unread.
        "." | "source" => return Step::Codex,
        "alias" => {
            return Step::found(
                args.iter()
                    .filter(|word| !is_option(word))
                    .filter_map(|word| word.split_once('=').map(|(_, value)| value))
                    .any(|value| command_line_launches_codex(value, depth)),
            );
        }
        "set-alias" | "new-alias" | "sal" | "nal" => {
            return Step::found(
                depth >= MAX_SHELL_DEPTH
                    || args.iter().filter(|word| !is_option(word)).any(|target| {
                        command_launches_codex(std::slice::from_ref(target), depth + 1)
                    }),
            );
        }
        // cmd.exe's `start`, and PowerShell's alias of `Start-Process`.
        "start" => {
            return if start_process_launches_codex(args, depth) {
                Step::Codex
            } else {
                Step::Runs(cmd_start_commands(args))
            };
        }
        "start-process" | "saps" => return Step::found(start_process_launches_codex(args, depth)),
        _ => {}
    }
    if let Some(launcher) = launcher(&name) {
        return launcher_step(&name, &launcher, args, depth);
    }
    if runs_inline_code(&name, args) {
        return Step::Codex;
    }
    if let Some(reading) = shell_reading(&name, args) {
        return Step::found(match reading {
            ShellReading::Unreadable => true,
            ShellReading::Commands(readings) => {
                depth >= MAX_SHELL_DEPTH
                    || readings
                        .iter()
                        .flatten()
                        .any(|command| command_launches_codex(command, depth + 1))
            }
        });
    }
    Step::found(match runner_call(&name, args) {
        Some(RunnerCall::Operands(operands)) => runner_launches_codex(operands, depth),
        Some(RunnerCall::PackageScript) => true,
        Some(RunnerCall::Entry(entry)) => node_entry_is_codex(entry) || is_dynamic(entry),
        None => false,
    })
}

/// Lower-case program name without directories or a Windows launcher extension.
fn program_name(program: &str) -> String {
    let base = program
        .rsplit(['/', '\\'])
        .next()
        .unwrap_or_default()
        .to_ascii_lowercase();
    base.trim_end_matches(".exe")
        .trim_end_matches(".cmd")
        .trim_end_matches(".bat")
        .trim_end_matches(".ps1")
        .to_owned()
}

fn is_option(word: &str) -> bool {
    word.len() > 1 && word.starts_with('-')
}

/// `NAME=value` before a program, as in `CODEX_HOME=/x npx …`.
fn is_assignment(word: &str) -> bool {
    word.split_once('=').is_some_and(|(name, _)| {
        let mut bytes = name.bytes();
        bytes
            .next()
            .is_some_and(|first| first.is_ascii_alphabetic() || first == b'_')
            && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
    })
}

/// A shell or cmd.exe expansion (`$NAME`, `${…}`, `$(…)`, `%NAME%`, `!NAME!`)
/// whose value is only known at launch.
fn is_dynamic(word: &str) -> bool {
    let posix = word.as_bytes().windows(2).any(|pair| {
        pair[0] == b'$'
            && (pair[1].is_ascii_alphanumeric() || matches!(pair[1], b'_' | b'{' | b'('))
    });
    posix || has_cmd_variable(word, '%') || has_cmd_variable(word, '!')
}

fn has_cmd_variable(word: &str, delimiter: char) -> bool {
    let parts = word.split(delimiter).collect::<Vec<_>>();
    parts.len() > 2
        && parts[1..parts.len() - 1].iter().any(|name| {
            let mut bytes = name.bytes();
            bytes
                .next()
                .is_some_and(|first| first.is_ascii_alphabetic() || first == b'_')
                && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        })
}
