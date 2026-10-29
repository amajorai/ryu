use super::*;

use std::collections::HashSet;

/// The words `xargs` appends from standard input: only known at launch.
pub(super) const STANDARD_INPUT_WORDS: &str = "${STDIN}";

pub(super) fn launcher_step<'a>(
    name: &str,
    launcher: &Launcher,
    args: &'a [String],
    depth: usize,
) -> Step<'a> {
    // `script -c LINE` runs LINE through a shell.
    let line = (name == "script")
        .then(|| script_command_line(args))
        .flatten();
    if line
        .as_deref()
        .is_some_and(|line| shell_line_launches_codex(line, depth))
    {
        return Step::Codex;
    }
    let starts = launched_command_starts(args, launcher);
    let commands = starts
        .iter()
        .map(|start| &args[*start..])
        .collect::<Vec<_>>();
    let options = &args[..starts.first().copied().unwrap_or(args.len())];
    let codex = match name {
        // xargs appends words from standard input, or puts them in place of
        // its replace string.
        "xargs" => {
            depth >= MAX_SHELL_DEPTH
                || commands.iter().any(|command| {
                    command_launches_codex(&with_standard_input(command, options), depth + 1)
                })
        }
        // watch hands its words to `sh -c` unless given `-x`.
        "watch" => commands
            .iter()
            .any(|command| shell_line_launches_codex(&command.join(" "), depth)),
        // With `-s` or `-i`, sudo and doas hand the words to a shell, which
        // reads standard input when there are none.
        "sudo" | "doas" if options.iter().any(|option| is_shell_option(option)) => {
            commands.is_empty()
                || commands
                    .iter()
                    .any(|command| shell_line_launches_codex(&command.join(" "), depth))
        }
        // Without a command, script runs an interactive shell on standard input.
        "script" => line.is_none() && commands.is_empty(),
        _ => false,
    };
    if codex {
        Step::Codex
    } else {
        Step::Runs(commands)
    }
}

/// Where the command a launcher runs may begin, under every reading of its
/// options: an option not known to be a switch might take the next word.
pub(super) fn launched_command_starts(args: &[String], launcher: &Launcher) -> Vec<usize> {
    let mut starts = Vec::new();
    let mut pending = vec![(0, launcher.operands)];
    let mut seen = HashSet::new();
    while let Some((index, operands)) = pending.pop() {
        if !seen.insert((index, operands)) {
            continue;
        }
        let Some(word) = args.get(index) else {
            continue;
        };
        if word == "--" {
            if index + 1 + operands < args.len() {
                starts.push(index + 1 + operands);
            }
            continue;
        }
        if !is_option(word) {
            if operands == 0 {
                starts.push(index);
            } else {
                pending.push((index + 1, operands - 1));
            }
            continue;
        }
        let option = word
            .split_once('=')
            .map_or(word.as_str(), |(option, _)| option);
        let attached_value = word.contains('=')
            || (!word.starts_with("--")
                && word.len() > 2
                && word
                    .get(..2)
                    .is_some_and(|short| launcher.valued.contains(&short)));
        if attached_value || launcher.switches.contains(&option) {
            pending.push((index + 1, operands));
        } else if launcher.valued.contains(&option) {
            pending.push((index + 2, operands));
        } else {
            pending.push((index + 1, operands));
            pending.push((index + 2, operands));
        }
    }
    starts.sort_unstable();
    starts.dedup();
    starts
}

/// A command line a launcher hands to `sh -c`.
pub(super) fn shell_line_launches_codex(line: &str, depth: usize) -> bool {
    depth >= MAX_SHELL_DEPTH
        || posix_commands(line).is_none_or(|commands| {
            commands
                .iter()
                .any(|command| command_launches_codex(command, depth + 1))
        })
}

/// `-s`/`--shell` or `-i`/`--login`, alone or in a cluster such as `-Es`.
pub(super) fn is_shell_option(option: &str) -> bool {
    matches!(option, "--shell" | "--login")
        || option.strip_prefix('-').is_some_and(|cluster| {
            !cluster.starts_with('-')
                && cluster.bytes().all(|byte| byte.is_ascii_alphabetic())
                && cluster.contains(['s', 'i'])
        })
}

/// The command `xargs` runs: its words with standard input in place of the
/// replace string (`-I R`; `-i` and `--replace` mean `{}`), then appended.
pub(super) fn with_standard_input(command: &[String], options: &[String]) -> Vec<String> {
    let mut replace = None;
    let mut words = options.iter();
    while let Some(word) = words.next() {
        if word == "-I" {
            replace = words.next().cloned();
        } else if word == "-i" || word == "--replace" {
            replace = Some("{}".to_owned());
        } else if let Some(value) = word.strip_prefix("--replace=") {
            replace = Some(value.to_owned());
        } else if let Some(value) = word.strip_prefix("-I").or_else(|| word.strip_prefix("-i")) {
            replace = Some(value.to_owned());
        }
    }
    let replace = replace.filter(|replace| !replace.is_empty());
    let mut words = command
        .iter()
        .map(|word| match &replace {
            Some(replace) if word.contains(replace.as_str()) => STANDARD_INPUT_WORDS.to_owned(),
            _ => word.clone(),
        })
        .collect::<Vec<_>>();
    words.push(STANDARD_INPUT_WORDS.to_owned());
    words
}

/// The line `script -c LINE` (also `--command LINE`, `-qc LINE`) runs.
pub(super) fn script_command_line(args: &[String]) -> Option<String> {
    let mut words = args.iter();
    while let Some(word) = words.next() {
        if word == "--" {
            break;
        }
        if let Some(line) = word.strip_prefix("--command=") {
            return Some(line.to_owned());
        }
        if word == "--command" {
            return words.next().cloned();
        }
        let Some(cluster) = word
            .strip_prefix('-')
            .filter(|cluster| !cluster.starts_with('-'))
        else {
            continue;
        };
        if let Some(position) = cluster.find('c') {
            let attached = &cluster[position + 1..];
            return if attached.is_empty() {
                words.next().cloned()
            } else {
                Some(attached.to_owned())
            };
        }
    }
    None
}

/// Switches of cmd.exe `start`; `/D`, `/NODE` and `/AFFINITY` take a value.
pub(super) const START_SWITCHES: &[&str] = &[
    "/b",
    "/i",
    "/min",
    "/max",
    "/separate",
    "/shared",
    "/low",
    "/normal",
    "/high",
    "/realtime",
    "/abovenormal",
    "/belownormal",
    "/wait",
    "/d",
    "/node",
    "/affinity",
];

/// cmd.exe `start ["title"] [/switch]… command [arguments]`. The title's
/// quotes are gone by now, so the command is read both in place of and after
/// a first word.
pub(super) fn cmd_start_commands(args: &[String]) -> Vec<&[String]> {
    let skip_switches = |mut index: usize| {
        while let Some(word) = args.get(index) {
            let lower = word.to_ascii_lowercase();
            let known = START_SWITCHES.contains(&lower.as_str());
            // `/Dpath` carries the directory attached.
            if !known && !lower.starts_with("/d") {
                break;
            }
            index += if matches!(lower.as_str(), "/d" | "/node" | "/affinity") {
                2
            } else {
                1
            };
        }
        index
    };
    let first = skip_switches(0);
    [first, skip_switches(first + 1)]
        .into_iter()
        .filter_map(|start| args.get(start..))
        .filter(|command| !command.is_empty())
        .collect()
}

/// PowerShell `Start-Process [-FilePath] program [[-ArgumentList] arguments]`
/// (also `saps` and `start`). The arguments are one string or a comma list.
pub(super) fn start_process_launches_codex(args: &[String], depth: usize) -> bool {
    let mut file = None;
    let mut arguments = None;
    let mut words = args.iter();
    while let Some(word) = words.next() {
        let parameter = word
            .strip_prefix('-')
            .filter(|name| name.starts_with(|first: char| first.is_ascii_alphabetic()));
        let Some(parameter) = parameter else {
            // Positional: the program, then its arguments.
            let value = array_value(word.clone(), &mut words);
            if file.is_none() {
                file = Some(value);
            } else if arguments.is_none() {
                arguments = Some(value);
            }
            continue;
        };
        let (name, attached) = match parameter.split_once(':') {
            Some((name, value)) => (name.to_ascii_lowercase(), Some(value.to_owned())),
            None => (parameter.to_ascii_lowercase(), None),
        };
        let is_switch = matches!(name.as_str(), "lup" | "nnw")
            || [
                "loaduserprofile",
                "nonewwindow",
                "passthru",
                "wait",
                "usenewenvironment",
            ]
            .iter()
            .any(|full| full.starts_with(&name));
        if is_switch && attached.is_none() {
            continue;
        }
        let Some(value) = attached.or_else(|| words.next().cloned()) else {
            break;
        };
        let value = array_value(value, &mut words);
        if "filepath".starts_with(&name) || matches!(name.as_str(), "pspath" | "path") {
            file = Some(value);
        } else if "argumentlist".starts_with(&name) || name == "args" {
            arguments = Some(value);
        }
    }
    let Some(file) = file else {
        return false;
    };
    if depth >= MAX_SHELL_DEPTH {
        return true;
    }
    let mut command = vec![file];
    command.extend(
        arguments
            .iter()
            .flat_map(|list| list.split(|ch: char| ch == ',' || ch.is_whitespace()))
            .filter(|word| !word.is_empty())
            .map(str::to_owned),
    );
    command_launches_codex(&command, depth + 1)
}

/// A PowerShell array argument written across words (`'-y', 'pkg'`).
pub(super) fn array_value(mut value: String, words: &mut std::slice::Iter<'_, String>) -> String {
    while value.ends_with(',')
        || words
            .as_slice()
            .first()
            .is_some_and(|next| next.starts_with(','))
    {
        let Some(next) = words.next() else {
            break;
        };
        value.push_str(next);
    }
    value
}
