use super::*;

use std::collections::HashSet;

/// Options of Node and Bun that run a program given inline.
pub(super) fn is_inline_program_option(word: &str) -> bool {
    matches!(
        word.split_once('=').map_or(word, |(option, _)| option),
        "-e" | "--eval" | "-p" | "--print" | "-pe" | "-ep"
    )
}

/// Python running a program given inline (`-c CODE`) or read from standard
/// input (`-`), and Bun evaluating code (`-e`, `--eval`, `--print`). Their text
/// is not read here. Node and Deno are read with their entries.
pub(super) fn runs_inline_code(name: &str, args: &[String]) -> bool {
    if name == "py" || name.starts_with("python") || name.starts_with("pypy") {
        return python_runs_inline_code(args);
    }
    if let Some(interpreter) = script_interpreter(name) {
        return script_interpreter_runs_inline_code(&interpreter, args);
    }
    if name != "bun" {
        return false;
    }
    let mut may_be_value = false;
    for word in args {
        if is_option(word) {
            if is_inline_program_option(word) {
                return true;
            }
            may_be_value = !word.contains('=');
            continue;
        }
        if !may_be_value {
            break;
        }
        may_be_value = false;
    }
    false
}

/// How Ruby and Perl read their switches, for [`script_interpreter_runs_inline_code`].
pub(super) struct ScriptInterpreter {
    /// Switches whose value is the inline program (`-e CODE`).
    inline: &'static [char],
    /// Switches whose value is the rest of the word, or the next word when the
    /// rest is empty (`-I DIR`, `-rLIB`).
    valued: &'static [char],
    /// Switches whose value is the rest of the word only (`-i.bak`, `-F:`).
    attached: &'static [char],
    /// Switches followed by optional octal digits (`-l`, `-0777`, or `-0xHH`).
    digits: &'static [char],
}

/// Ruby (`ruby`, `ruby3.3`, `jruby`) and Perl (`perl`, `perl5.36`).
pub(super) fn script_interpreter(name: &str) -> Option<ScriptInterpreter> {
    let versioned = |base: &str| {
        name.strip_prefix(base)
            .is_some_and(|rest| rest.chars().all(|ch| ch.is_ascii_digit() || ch == '.'))
    };
    if versioned("ruby") || name == "jruby" || name == "truffleruby" {
        return Some(ScriptInterpreter {
            inline: &['e'],
            valued: &['r', 'I', 'C', 'E'],
            attached: &['F', 'i', 'K', 'T', 'W', 'x'],
            digits: &['0'],
        });
    }
    if versioned("perl") {
        return Some(ScriptInterpreter {
            inline: &['e', 'E'],
            valued: &['I', 'M', 'm', 'C', 'd', 'D', 'x'],
            attached: &['F', 'i', 'V'],
            digits: &['0', 'l'],
        });
    }
    None
}

/// Ruby or Perl running a program given inline (`ruby -e CODE`, `perl -ne
/// CODE`), or read from standard input: `-`, or no script at all (only version
/// and help switches run nothing). A word that may be a switch's value is
/// skipped, so an unusual spelling reads as inline code rather than a script.
pub(super) fn script_interpreter_runs_inline_code(
    interpreter: &ScriptInterpreter,
    args: &[String],
) -> bool {
    let mut words = args.iter();
    let mut information = false;
    while let Some(word) = words.next() {
        if word == "-" {
            return true;
        }
        let Some(flags) = word.strip_prefix('-') else {
            // The script file.
            return false;
        };
        if let Some(long) = flags.strip_prefix('-') {
            if long.is_empty() {
                return words.next().is_none_or(|script| script == "-");
            }
            information |= long == "version" || long.starts_with("help");
            continue;
        }
        let mut chars = flags.chars().peekable();
        while let Some(flag) = chars.next() {
            if interpreter.inline.contains(&flag) {
                return true;
            }
            if interpreter.valued.contains(&flag) {
                if chars.peek().is_none() {
                    words.next();
                }
                break;
            }
            if interpreter.attached.contains(&flag) {
                break;
            }
            if interpreter.digits.contains(&flag) {
                // Octal digits, or `-0xHH`: never a later switch letter.
                if flag == '0' && chars.next_if(|ch| matches!(ch, 'x' | 'X')).is_some() {
                    while chars.next_if(char::is_ascii_hexdigit).is_some() {}
                } else {
                    while chars.next_if(|ch| ch.is_digit(8)).is_some() {}
                }
                continue;
            }
            information |= matches!(flag, 'v' | 'h');
        }
    }
    !information
}

/// Python running `-c CODE`, or a program read from standard input: `-`, or
/// no script at all (only `--version` and `--help` run nothing).
pub(super) fn python_runs_inline_code(args: &[String]) -> bool {
    let mut words = args.iter();
    let mut information = false;
    while let Some(word) = words.next() {
        if word == "-" {
            return true;
        }
        let Some(flags) = word.strip_prefix('-') else {
            // The script file.
            return false;
        };
        if let Some(long) = flags.strip_prefix('-') {
            if long.is_empty() {
                return words.next().is_none_or(|script| script == "-");
            }
            information |= long == "version" || long.starts_with("help");
            continue;
        }
        for (position, flag) in flags.char_indices() {
            match flag {
                'c' => return true,
                // A module run by name.
                'm' => return false,
                'V' | 'h' | '?' => information = true,
                // `-W` and `-X` take the rest of the word, or the next word.
                'W' | 'X' => {
                    if flags[position + 1..].is_empty() {
                        words.next();
                    }
                    break;
                }
                _ => {}
            }
        }
    }
    !information
}

/// Deno subcommands that run no program.
pub(super) const DENO_NON_RUNNING: &[&str] = &[
    "add",
    "approve-scripts",
    "bundle",
    "cache",
    "check",
    "clean",
    "compile",
    "completions",
    "coverage",
    "doc",
    "fmt",
    "help",
    "i",
    "info",
    "init",
    "install",
    "jupyter",
    "lint",
    "lsp",
    "outdated",
    "publish",
    "remove",
    "types",
    "uninstall",
    "update",
    "upgrade",
    "vendor",
];

/// Deno options known to take no value. `--allow-*`, `--deny-*`, `--no-*`,
/// `--unstable*` and `--inspect*` take theirs only after `=`.
pub(super) fn is_deno_switch(option: &str) -> bool {
    matches!(
        option,
        "-A" | "-q"
            | "--quiet"
            | "-r"
            | "--reload"
            | "--check"
            | "--watch"
            | "--cached-only"
            | "--frozen"
            | "-P"
    ) || ["--allow-", "--deny-", "--no-", "--unstable", "--inspect"]
        .iter()
        .any(|prefix| option.starts_with(prefix))
}

/// Deno global options that take the next word as their value; they are
/// accepted before the subcommand (`deno -L debug run …`).
pub(super) const DENO_VALUED_GLOBALS: &[&str] = &["-L", "--log-level"];

/// `deno [run|serve|test|bench|x] [OPTIONS] SPECIFIER` and `deno SPECIFIER`
/// run the specifier; `deno eval CODE`, `deno task NAME` (a deno.json or
/// package.json task), `deno repl` and `deno` with no subcommand (a REPL
/// reading standard input) run what this classifier cannot read. Options
/// before the subcommand are read every way they might be: any reading that
/// launches Codex counts.
pub(super) fn deno_launches_codex(args: &[String]) -> bool {
    deno_subcommand_starts(args)
        .into_iter()
        .any(|start| match start {
            Some(first) => deno_command_launches_codex(args, first),
            // No subcommand: the REPL, which runs what standard input gives it.
            None => !args
                .iter()
                .any(|option| matches!(option.as_str(), "-V" | "--version" | "-h" | "--help")),
        })
}

/// Where the deno subcommand (or a bare specifier) may begin, under every
/// reading of the options before it: an option not known to be a switch might
/// take the next word as its value. `None` is a reading with no subcommand.
pub(super) fn deno_subcommand_starts(args: &[String]) -> Vec<Option<usize>> {
    let mut starts = Vec::new();
    let mut pending = vec![0];
    let mut seen = HashSet::new();
    while let Some(index) = pending.pop() {
        if !seen.insert(index) {
            continue;
        }
        let Some(word) = args.get(index) else {
            starts.push(None);
            continue;
        };
        if !is_option(word) {
            starts.push(Some(index));
            continue;
        }
        let option = word
            .split_once('=')
            .map_or(word.as_str(), |(option, _)| option);
        let attached_value = word.contains('=')
            || (!word.starts_with("--") && word.len() > 2 && word.starts_with("-L"));
        if attached_value || is_deno_switch(option) {
            pending.push(index + 1);
        } else if DENO_VALUED_GLOBALS.contains(&option) {
            pending.push(index + 2);
        } else {
            pending.push(index + 1);
            pending.push(index + 2);
        }
    }
    starts
}

/// The deno command whose subcommand (or bare specifier) is `args[first]`.
pub(super) fn deno_command_launches_codex(args: &[String], first: usize) -> bool {
    let operands = match args[first].as_str() {
        "eval" | "task" | "repl" => return true,
        "run" | "serve" | "test" | "bench" | "x" => &args[first + 1..],
        subcommand if DENO_NON_RUNNING.contains(&subcommand) => return false,
        _ => &args[first..],
    };
    let mut words = operands.iter();
    let mut may_be_value = false;
    while let Some(word) = words.next() {
        if word == "--" {
            return words
                .next()
                .is_some_and(|specifier| deno_specifier_is_codex(specifier));
        }
        if is_option(word) {
            may_be_value = !word.contains('=') && !is_deno_switch(word);
            continue;
        }
        if deno_specifier_is_codex(word) {
            return true;
        }
        if !may_be_value {
            return false;
        }
        may_be_value = false;
    }
    false
}

/// An `npm:` or `jsr:` package, URL or path that names Codex.
pub(super) fn deno_specifier_is_codex(specifier: &str) -> bool {
    let lower = specifier.to_ascii_lowercase();
    let package = lower
        .strip_prefix("npm:")
        .or_else(|| lower.strip_prefix("jsr:"))
        .map(|package| package.trim_start_matches('/'));
    package.is_some_and(names_codex_package)
        || lower.contains("codex-acp")
        || node_entry_is_codex(specifier)
        || is_dynamic(specifier)
}
