use super::*;

use std::iter::Peekable;
use std::str::Chars;

use base64::{engine::general_purpose, Engine};

/// A command line whose shell is not known: read it as both POSIX and cmd.exe.
pub(super) fn command_line_launches_codex(line: &str, depth: usize) -> bool {
    shell_line_launches_codex(line, depth)
        || cmd_commands(line)
            .iter()
            .any(|command| command_launches_codex(command, depth + 1))
}

/// What a shell wrapper runs.
pub(super) enum ShellReading {
    /// The simple commands under every plausible reading of its arguments.
    Commands(Vec<Vec<Vec<String>>>),
    /// Commands from a script file, standard input, an undecodable block, or a
    /// script whose quoting or substitutions never close.
    Unreadable,
}

impl From<Option<Vec<Vec<String>>>> for ShellReading {
    fn from(commands: Option<Vec<Vec<String>>>) -> Self {
        commands.map_or(Self::Unreadable, |commands| Self::Commands(vec![commands]))
    }
}

/// How a shell wrapper reads its commands, or `None` when `name` is not a shell.
pub(super) fn shell_reading(name: &str, args: &[String]) -> Option<ShellReading> {
    match name {
        "cmd" => Some(cmd_reading(args)),
        "sh" | "bash" | "zsh" | "dash" | "ash" | "ksh" | "mksh" | "fish" => Some(
            ShellReading::from(posix_script(args).and_then(|script| shell_commands(name, &script))),
        ),
        "pwsh" | "powershell" => Some(powershell_reading(name == "powershell", args)),
        "eval" => Some(ShellReading::from(posix_commands(&args.join(" ")))),
        // The action is shell code the shell runs when a condition fires.
        "trap" => Some(ShellReading::from(
            trap_action(args).map_or_else(|| Some(Vec::new()), posix_commands),
        )),
        "invoke-expression" | "iex" => {
            Some(ShellReading::from(powershell_commands(&args.join(" "))))
        }
        _ => None,
    }
}

/// The action of `trap [--] ACTION CONDITION…`: its first operand. `-`
/// (reset), an empty action and the listing options (`-p`, `-l`) read as code
/// that starts nothing.
pub(super) fn trap_action(args: &[String]) -> Option<&str> {
    let mut operands = args.iter();
    let first = operands.next()?;
    let action = if first == "--" {
        operands.next()?
    } else {
        first
    };
    Some(action.as_str())
}

/// `cmd /c LINE` (also `/k`, `/r`). Without one of those switches cmd.exe
/// reads its commands from standard input.
pub(super) fn cmd_reading(args: &[String]) -> ShellReading {
    let switches = args
        .iter()
        .take_while(|arg| is_cmd_switch(arg))
        .collect::<Vec<_>>();
    if !switches
        .iter()
        .any(|switch| matches!(switch.to_ascii_lowercase().as_str(), "/c" | "/k" | "/r"))
    {
        return ShellReading::Unreadable;
    }
    let line = &args[switches.len()..];
    ShellReading::Commands(match line {
        [single] => vec![cmd_commands(single)],
        // Pre-split words lost their quoting: read them both re-joined as given
        // and with whitespace-bearing words quoted.
        words => vec![
            cmd_commands(&words.join(" ")),
            cmd_commands(
                &words
                    .iter()
                    .map(|word| {
                        if word.contains(char::is_whitespace) && !word.contains('"') {
                            format!("\"{word}\"")
                        } else {
                            word.clone()
                        }
                    })
                    .collect::<Vec<_>>()
                    .join(" "),
            ),
        ],
    })
}

/// `/c`, `/d`, `/s`, `/v:on` and similar cmd.exe switches.
pub(super) fn is_cmd_switch(arg: &str) -> bool {
    let bytes = arg.as_bytes();
    bytes.len() >= 2
        && bytes[0] == b'/'
        && bytes[1].is_ascii_alphabetic()
        && (bytes.len() == 2 || bytes[2] == b':')
}

/// The command string of `sh -c script` (also `-lc`, `-ec`, `--command`).
/// `None` means the shell reads a script file or standard input.
pub(super) fn posix_script(args: &[String]) -> Option<String> {
    let mut words = args.iter();
    let mut command_flag = false;
    while let Some(word) = words.next() {
        if let Some(script) = word.strip_prefix("--command=") {
            return Some(script.to_owned());
        }
        match word.as_str() {
            "--" => break,
            "--command" => command_flag = true,
            "-o" | "+o" | "-O" | "+O" | "--rcfile" | "--init-file" => {
                words.next();
            }
            option if option.starts_with("--") => {}
            option if option.len() > 1 && (option.starts_with('-') || option.starts_with('+')) => {
                command_flag |= option.starts_with('-') && option[1..].contains('c');
            }
            operand => return command_flag.then(|| operand.to_owned()),
        }
    }
    command_flag.then(|| words.next().cloned()).flatten()
}

/// How a PowerShell host parameter is read. PowerShell accepts any unambiguous
/// prefix of a parameter name, with `-`, `--` or `/`.
pub(super) enum PowerShellParameter {
    Command,
    File,
    EncodedCommand,
    TakesValue,
    Switch,
}

pub(super) fn powershell_parameter(word: &str) -> Option<PowerShellParameter> {
    let name = word
        .strip_prefix("--")
        .or_else(|| word.strip_prefix('-'))
        .or_else(|| word.strip_prefix('/'))
        .filter(|name| !name.is_empty())?
        .to_ascii_lowercase();
    let prefix_of = |full: &str, shortest: usize| name.len() >= shortest && full.starts_with(&name);
    Some(
        if name == "c"
            || name == "cwa"
            || prefix_of("command", 3)
            || prefix_of("commandwithargs", 8)
        {
            PowerShellParameter::Command
        } else if name == "f" || prefix_of("file", 2) {
            PowerShellParameter::File
        } else if matches!(name.as_str(), "e" | "ec") || prefix_of("encodedcommand", 2) {
            PowerShellParameter::EncodedCommand
        } else if matches!(
            name.as_str(),
            "ep" | "ex" | "wd" | "w" | "o" | "of" | "if" | "v" | "ea" | "settings"
        ) || [
            "executionpolicy",
            "workingdirectory",
            "windowstyle",
            "outputformat",
            "inputformat",
            "configurationname",
            "configurationfile",
            "custompipename",
            "settingsfile",
            "version",
            "psconsolefile",
            "encodedarguments",
        ]
        .iter()
        .any(|full| prefix_of(full, 3))
        {
            PowerShellParameter::TakesValue
        } else {
            PowerShellParameter::Switch
        },
    )
}

/// The script a PowerShell host runs. PowerShell 7 (`pwsh`) runs its first
/// positional argument as a script file; Windows PowerShell runs the remaining
/// words as a command. Without a command PowerShell reads standard input.
pub(super) fn powershell_reading(windows_powershell: bool, args: &[String]) -> ShellReading {
    let mut index = 0;
    while let Some(word) = args.get(index) {
        let Some(parameter) = powershell_parameter(word) else {
            if !windows_powershell {
                return ShellReading::Unreadable;
            }
            // A value of an option this reader does not know may come first,
            // so read the command from every positional word onward.
            return (index..args.len())
                .filter(|start| powershell_parameter(&args[*start]).is_none())
                .map(|start| powershell_commands(&args[start..].join(" ")))
                .collect::<Option<Vec<_>>>()
                .map_or(ShellReading::Unreadable, ShellReading::Commands);
        };
        match parameter {
            PowerShellParameter::Command => {
                let script = args[index + 1..].join(" ");
                return if script.trim().is_empty() || script.trim() == "-" {
                    ShellReading::Unreadable
                } else {
                    ShellReading::from(powershell_commands(&script))
                };
            }
            PowerShellParameter::File => return ShellReading::Unreadable,
            PowerShellParameter::EncodedCommand => {
                return ShellReading::from(
                    args.get(index + 1)
                        .and_then(|encoded| decode_powershell_command(encoded))
                        .and_then(|script| powershell_commands(&script)),
                );
            }
            PowerShellParameter::TakesValue => index += 2,
            PowerShellParameter::Switch => index += 1,
        }
    }
    ShellReading::Unreadable
}

/// `-EncodedCommand` carries Base64 of the UTF-16LE script.
pub(super) fn decode_powershell_command(encoded: &str) -> Option<String> {
    let encoded = encoded.trim();
    let bytes = general_purpose::STANDARD
        .decode(encoded)
        .or_else(|_| general_purpose::STANDARD_NO_PAD.decode(encoded))
        .ok()?;
    if bytes.len() % 2 != 0 {
        return None;
    }
    let units = bytes
        .chunks_exact(2)
        .map(|pair| u16::from_le_bytes([pair[0], pair[1]]));
    let script = char::decode_utf16(units)
        .collect::<Result<String, _>>()
        .ok()?;
    Some(script.trim_start_matches('\u{feff}').to_owned())
}

/// Word and command boundaries shared by the cmd.exe and POSIX readers.
#[derive(Default)]
pub(super) struct Lexer {
    pub(super) commands: Vec<Vec<String>>,
    pub(super) command: Vec<String>,
    pub(super) word: String,
    pub(super) in_word: bool,
    pub(super) redirect_target: bool,
}

impl Lexer {
    pub(super) fn push(&mut self, ch: char) {
        self.word.push(ch);
        self.in_word = true;
    }

    /// Quotes form a word even when empty.
    pub(super) fn quote(&mut self) {
        self.in_word = true;
    }

    pub(super) fn end_word(&mut self) {
        if !self.in_word {
            return;
        }
        self.in_word = false;
        let word = std::mem::take(&mut self.word);
        // A redirection target (`> codex.log`) is not part of the command.
        if !std::mem::take(&mut self.redirect_target) {
            self.command.push(word);
        }
    }

    pub(super) fn end_command(&mut self) {
        self.end_word();
        self.redirect_target = false;
        if !self.command.is_empty() {
            self.commands.push(std::mem::take(&mut self.command));
        }
    }

    /// `>`, `>>`, `2>`, `<` and `>&1`: drop the operator, its descriptor and target.
    pub(super) fn redirect(&mut self, chars: &mut Peekable<Chars<'_>>) {
        self.drop_descriptor();
        while chars.next_if(|ch| matches!(ch, '>' | '<' | '|')).is_some() {}
        if chars.next_if_eq(&'&').is_some() {
            while chars
                .next_if(|ch| ch.is_ascii_digit() || *ch == '-')
                .is_some()
            {}
            return;
        }
        self.redirect_target = true;
    }

    /// End the word before a redirection, dropping it when it is the
    /// redirection's file descriptor (`2>`).
    pub(super) fn drop_descriptor(&mut self) {
        if self.in_word && self.word.bytes().all(|byte| byte.is_ascii_digit()) {
            self.word.clear();
            self.in_word = false;
        } else {
            self.end_word();
        }
    }

    /// Command substitution: its commands run on their own, and the word it
    /// appears in is only known at launch, so it is marked as an expansion.
    pub(super) fn substitute(&mut self, commands: Vec<Vec<String>>) {
        self.commands.extend(commands);
        self.push('$');
        self.push('(');
        self.push(')');
    }

    pub(super) fn finish(mut self) -> Vec<Vec<String>> {
        self.end_command();
        self.commands
    }
}

/// Simple commands of a cmd.exe line. Double quotes group text and `^`
/// escapes the next character; unquoted `&`, `|`, parentheses and newlines
/// separate commands.
pub(super) fn cmd_commands(line: &str) -> Vec<Vec<String>> {
    let mut lexer = Lexer::default();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(ch) = chars.next() {
        match ch {
            '"' => {
                quoted = !quoted;
                lexer.quote();
            }
            _ if quoted => lexer.push(ch),
            '^' => {
                if let Some(next) = chars.next() {
                    lexer.push(next);
                }
            }
            '&' | '|' | '(' | ')' | '\n' | '\r' => lexer.end_command(),
            '>' | '<' => lexer.redirect(&mut chars),
            ch if ch.is_whitespace() => lexer.end_word(),
            ch => lexer.push(ch),
        }
    }
    lexer.finish()
}

/// Simple commands of a POSIX shell script, or `None` when it cannot be read:
/// a quote, `$(…)` or backtick substitution that is never closed, or a `case`
/// inside `$(…)`, whose patterns end in `)` too.
///
/// The shell is not known here (`eval`, a launcher's `sh -c`, an alias), so a
/// script using bash's `$'…'` is read both as bash and as a POSIX shell reads
/// it, and the commands of both readings count.
pub(super) fn posix_commands(script: &str) -> Option<Vec<Vec<String>>> {
    shell_commands("sh", script)
}
