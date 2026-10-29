use super::*;

/// `env [OPTION]… [NAME=VALUE]… [COMMAND [ARG]…]`. `-S STRING` (also
/// `--split-string`, `-S` inside an option cluster or with the string attached)
/// splits STRING into further options, assignments and the command, followed
/// by the remaining arguments.
pub(super) fn env_launches_codex(args: &[String], depth: usize) -> bool {
    let mut index = 0;
    while let Some(word) = args.get(index) {
        if !is_option(word) {
            break;
        }
        index += 1;
        let split = if let Some(value) = word.strip_prefix("--split-string=") {
            Some(value.to_owned())
        } else if word == "--split-string" {
            index += 1;
            args.get(index - 1).cloned()
        } else if let Some(position) = (!word.starts_with("--")).then(|| word.find('S')).flatten() {
            let attached = &word[position + 1..];
            if attached.is_empty() {
                index += 1;
                args.get(index - 1).cloned()
            } else {
                Some(attached.to_owned())
            }
        } else {
            if matches!(
                word.as_str(),
                "-u" | "--unset" | "-C" | "--chdir" | "-a" | "--argv0" | "-P"
            ) {
                index += 1;
            }
            continue;
        };
        let Some(split) = split else {
            return false;
        };
        if depth >= MAX_SHELL_DEPTH {
            return true;
        }
        let mut words = vec!["env".to_owned()];
        words.extend(split_env_string(&split));
        words.extend(args.get(index..).unwrap_or_default().iter().cloned());
        return command_launches_codex(&words, depth + 1);
    }
    command_launches_codex(args.get(index..).unwrap_or_default(), depth)
}

/// Words of an `env -S` string: whitespace separates, quotes group, a
/// backslash escapes (`\_` is a space, `\c` ends the string) and an unquoted
/// `#` starting a word begins a comment. `${NAME}` is kept so it reads as an
/// expansion.
pub(super) fn split_env_string(text: &str) -> Vec<String> {
    let mut words = Vec::new();
    let mut word = String::new();
    let mut in_word = false;
    let (mut single, mut double) = (false, false);
    let mut chars = text.chars();
    while let Some(ch) = chars.next() {
        if single {
            if ch == '\'' {
                single = false;
            } else {
                word.push(ch);
            }
            continue;
        }
        match ch {
            '\'' if !double => {
                single = true;
                in_word = true;
            }
            '"' => {
                double = !double;
                in_word = true;
            }
            '\\' => match chars.next() {
                Some('_') => {
                    word.push(' ');
                    in_word = true;
                }
                Some('c') => break,
                Some(next) => {
                    word.push(next);
                    in_word = true;
                }
                None => {}
            },
            '#' if !double && !in_word => break,
            ch if ch.is_whitespace() && !double => {
                if in_word {
                    words.push(std::mem::take(&mut word));
                    in_word = false;
                }
            }
            ch => {
                word.push(ch);
                in_word = true;
            }
        }
    }
    if in_word {
        words.push(word);
    }
    words
}

/// A program that runs the command given in its arguments.
pub(super) struct Launcher {
    /// Options known to take no value.
    pub(super) switches: &'static [&'static str],
    /// Options known to take the next word (or an attached value) as their value.
    pub(super) valued: &'static [&'static str],
    /// Operands before the command, such as `timeout`'s duration.
    pub(super) operands: usize,
}

/// The launchers this classifier reads through, by program name.
pub(super) fn launcher(name: &str) -> Option<Launcher> {
    let (switches, valued, operands): (&[&str], &[&str], usize) = match name {
        "exec" => (&["-c", "-l"], &["-a"], 0),
        "command" => (&["-p", "-v", "-V"], &[], 0),
        "builtin" | "nohup" | "call" => (&[], &[], 0),
        "time" => (
            &[
                "-p",
                "--portability",
                "-a",
                "--append",
                "-v",
                "--verbose",
                "-q",
                "--quiet",
            ],
            &["-f", "--format", "-o", "--output"],
            0,
        ),
        "nice" => (&[], &["-n", "--adjustment"], 0),
        "timeout" => (
            &["--preserve-status", "--foreground", "-v", "--verbose"],
            &["-k", "--kill-after", "-s", "--signal"],
            1,
        ),
        "sudo" => (
            &[
                "-A",
                "--askpass",
                "-B",
                "--bell",
                "-b",
                "--background",
                "-E",
                "--preserve-env",
                "-e",
                "--edit",
                "-H",
                "--set-home",
                "-i",
                "--login",
                "-K",
                "--remove-timestamp",
                "-k",
                "--reset-timestamp",
                "-N",
                "--no-update",
                "-n",
                "--non-interactive",
                "-P",
                "--preserve-groups",
                "-S",
                "--stdin",
                "-s",
                "--shell",
            ],
            &[
                "-C",
                "--close-from",
                "-D",
                "--chdir",
                "-g",
                "--group",
                "-p",
                "--prompt",
                "-R",
                "--chroot",
                "-r",
                "--role",
                "-T",
                "--command-timeout",
                "-t",
                "--type",
                "-U",
                "--other-user",
                "-u",
                "--user",
            ],
            0,
        ),
        "doas" => (&["-n", "-s", "-L"], &["-C", "-u"], 0),
        "setsid" => (&["-c", "--ctty", "-f", "--fork", "-w", "--wait"], &[], 0),
        "stdbuf" => (
            &[],
            &["-i", "--input", "-o", "--output", "-e", "--error"],
            0,
        ),
        "ionice" => (
            &["-t", "--ignore"],
            &[
                "-c",
                "--class",
                "-n",
                "--classdata",
                "-p",
                "--pid",
                "-P",
                "--pgid",
                "-u",
                "--uid",
            ],
            0,
        ),
        "taskset" => (
            &["-a", "--all-tasks", "-c", "--cpu-list", "-p", "--pid"],
            &[],
            1,
        ),
        "chrt" => (
            &[
                "-a",
                "--all-tasks",
                "-b",
                "--batch",
                "-d",
                "--deadline",
                "-e",
                "--ext",
                "-f",
                "--fifo",
                "-i",
                "--idle",
                "-o",
                "--other",
                "-r",
                "--rr",
                "-R",
                "--reset-on-fork",
                "-v",
                "--verbose",
            ],
            &[
                "-T",
                "--sched-runtime",
                "-P",
                "--sched-period",
                "-D",
                "--sched-deadline",
            ],
            1,
        ),
        "unbuffer" => (&["-p"], &[], 0),
        "caffeinate" => (&["-d", "-i", "-m", "-s", "-u"], &["-t", "-w"], 0),
        "xargs" => (
            &[
                "-0",
                "--null",
                "-o",
                "--open-tty",
                "-p",
                "--interactive",
                "-r",
                "--no-run-if-empty",
                "-t",
                "--verbose",
                "-x",
                "--exit",
                "--show-limits",
            ],
            &[
                "-a",
                "--arg-file",
                "-d",
                "--delimiter",
                "-E",
                "-I",
                "-L",
                "--max-lines",
                "-n",
                "--max-args",
                "-P",
                "--max-procs",
                "-s",
                "--max-chars",
                "--process-slot-var",
            ],
            0,
        ),
        "watch" => (
            &[
                "-b",
                "--beep",
                "-c",
                "--color",
                "-C",
                "--no-color",
                "-d",
                "--differences",
                "-e",
                "--errexit",
                "-g",
                "--chgexit",
                "-p",
                "--precise",
                "-r",
                "--no-rerun",
                "-t",
                "--no-title",
                "-w",
                "--no-wrap",
                "-x",
                "--exec",
            ],
            &["-n", "--interval", "-q", "--equexit"],
            0,
        ),
        "script" => (
            &[
                "-a", "--append", "-e", "--return", "-f", "--flush", "-q", "--quiet", "-k", "-d",
                "-p", "-r",
            ],
            &[
                "-c",
                "--command",
                "-E",
                "--echo",
                "-I",
                "--log-in",
                "-O",
                "--log-out",
                "-B",
                "--log-io",
                "-T",
                "--log-timing",
                "-m",
                "--logging-format",
                "-o",
                "--output-limit",
                "-F",
            ],
            1,
        ),
        _ => return None,
    };
    Some(Launcher {
        switches,
        valued,
        operands,
    })
}
