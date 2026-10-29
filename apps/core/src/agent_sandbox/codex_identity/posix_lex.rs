use super::*;

use std::iter::Peekable;
use std::str::Chars;

/// How a shell quotes, where that changes which text is a command.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum Dialect {
    /// `'…'` ends at the next quote; `$'…'` is `$` and a `'…'` string.
    Posix,
    /// bash, zsh and ksh: `$'…'` is one string in which `\'` is a quote.
    Bash,
    /// fish: `\'` and `\\` are escapes inside `'…'`.
    Fish,
}

/// Simple commands of a script run by the shell `name`, under each way that
/// shell may quote (`sh` may be bash or a POSIX shell such as dash).
pub(super) fn shell_commands(name: &str, script: &str) -> Option<Vec<Vec<String>>> {
    match name {
        "bash" | "zsh" | "ksh" | "mksh" => posix_reading(script, Dialect::Bash),
        "fish" => posix_reading(script, Dialect::Fish),
        "dash" | "ash" => posix_reading(script, Dialect::Posix),
        _ => {
            let mut commands = posix_reading(script, Dialect::Posix)?;
            if script.contains("$'") {
                commands.extend(posix_reading(script, Dialect::Bash)?);
            }
            Some(commands)
        }
    }
}

/// One reading of a POSIX-style shell script.
pub(super) fn posix_reading(script: &str, dialect: Dialect) -> Option<Vec<Vec<String>>> {
    let mut lexer = Lexer::default();
    posix_lex(&mut script.chars().peekable(), &mut lexer, false, dialect)?;
    Some(lexer.finish())
}

/// A here-document waiting for the end of its line: `<<WORD` or `<<-WORD`.
pub(super) struct Heredoc {
    delimiter: String,
    /// `<<-` strips leading tabs from body lines, so an indented delimiter ends it.
    strip_tabs: bool,
    /// An unquoted delimiter expands the body: its substitutions run.
    expands: bool,
}

/// Reads POSIX shell commands into `lexer` until the script ends or, for the
/// body of a `$(…)` (`nested`), until the unquoted `)` that closes it. Single
/// quotes are literal, double quotes group text, `#` starting a word begins a
/// comment, command substitution runs its own commands even inside double
/// quotes, and a here-document's body is data up to its delimiter line.
pub(super) fn posix_lex(
    chars: &mut Peekable<Chars<'_>>,
    lexer: &mut Lexer,
    nested: bool,
    dialect: Dialect,
) -> Option<()> {
    let mut double = false;
    let mut depth = 0_usize;
    let mut heredocs = Vec::new();
    // Closers of the `${…}` and `$[…]` expansions open here, whose text
    // (`${x/<<}`, `$[1<<2]`) holds no redirections.
    let mut expansions = Vec::new();
    while let Some(ch) = chars.next() {
        match ch {
            '\'' if !double => {
                lexer.quote();
                loop {
                    match chars.next()? {
                        '\'' => break,
                        '\\' if dialect == Dialect::Fish
                            && matches!(chars.peek(), Some('\'' | '\\')) =>
                        {
                            lexer.push(chars.next()?);
                        }
                        ch => lexer.push(ch),
                    }
                }
            }
            '"' => {
                double = !double;
                lexer.quote();
            }
            '\\' => match chars.next() {
                Some('\n') | None => {}
                Some(next) if double && !matches!(next, '"' | '\\' | '$' | '`') => {
                    lexer.push('\\');
                    lexer.push(next);
                }
                Some(next) => lexer.push(next),
            },
            '$' if dialect == Dialect::Bash && !double && chars.peek() == Some(&'\'') => {
                chars.next();
                lexer.quote();
                ansi_c_string(chars, lexer)?;
            }
            '$' if chars.peek() == Some(&'(') => {
                chars.next();
                lexer.substitute(posix_substitution(chars, dialect)?);
            }
            '`' => {
                let commands = posix_reading(&backquoted(chars)?, dialect)?;
                lexer.substitute(commands);
            }
            _ if double => lexer.push(ch),
            '$' if matches!(chars.peek(), Some('{' | '[')) => {
                let open = chars.next()?;
                expansions.push(if open == '{' { '}' } else { ']' });
                lexer.push('$');
                lexer.push(open);
            }
            '}' | ']' if expansions.last() == Some(&ch) => {
                expansions.pop();
                lexer.push(ch);
            }
            // Inside `${x:-)}` a parenthesis is the expansion's text: it opens
            // no subshell and does not close the `$(…)` around it.
            '(' | ')' if !expansions.is_empty() => lexer.push(ch),
            '#' if !lexer.in_word => skip_comment(chars),
            '(' => {
                depth += 1;
                lexer.end_command();
            }
            ')' => {
                if nested && depth == 0 {
                    return Some(());
                }
                depth = depth.saturating_sub(1);
                lexer.end_command();
            }
            '\n' => {
                lexer.end_command();
                // Here-document bodies start on the next line, in order.
                for heredoc in std::mem::take(&mut heredocs) {
                    heredoc_body(chars, &heredoc, lexer, dialect)?;
                }
            }
            ';' | '&' | '|' => lexer.end_command(),
            '<' if expansions.is_empty() && chars.peek() == Some(&'<') => {
                chars.next();
                if chars.peek() == Some(&'<') {
                    // A `<<<` here-string: its word is input, not a command.
                    lexer.redirect(chars);
                } else if depth > 0 {
                    // Inside `(( … ))` or `$(( … ))` this is a shift, in a
                    // subshell a here-document: it cannot be told apart here.
                    return None;
                } else {
                    lexer.drop_descriptor();
                    let strip_tabs = chars.next_if_eq(&'-').is_some();
                    heredocs.push(heredoc_operator(chars, strip_tabs)?);
                }
            }
            '>' | '<' if expansions.is_empty() => lexer.redirect(chars),
            ch if ch.is_whitespace() => lexer.end_word(),
            ch => lexer.push(ch),
        }
    }
    // The script ended: readable only outside quotes and substitutions.
    (!double && !nested).then_some(())
}

/// The commands of a `$(…)` substitution, read up to the unquoted `)` that
/// closes it.
pub(super) fn posix_substitution(
    chars: &mut Peekable<Chars<'_>>,
    dialect: Dialect,
) -> Option<Vec<Vec<String>>> {
    let mut inner = Lexer::default();
    posix_lex(chars, &mut inner, true, dialect)?;
    let commands = inner.finish();
    // A `case` pattern ends in `)` as well, so the substitution may have been
    // closed early and cannot be delimited.
    (!commands.iter().any(|command| starts_case(command))).then_some(commands)
}

/// A simple command that opens a `case` statement, after any reserved words
/// that lead into it (`then case …`, `do case …`).
pub(super) fn starts_case(command: &[String]) -> bool {
    command
        .iter()
        .find(|word| {
            !matches!(
                word.as_str(),
                "{" | "!" | "if" | "then" | "elif" | "else" | "while" | "until" | "do" | "time"
            )
        })
        .is_some_and(|word| word == "case")
}

/// The body of bash's `$'…'` after its opening quote. `\'`, `\"`, `\\` and
/// `\?` are the characters themselves; any other escape (`\x63`, `\143`,
/// `\u…`, `\n`) spells a character that is only known once decoded, so the
/// word is marked as an expansion.
pub(super) fn ansi_c_string(chars: &mut Peekable<Chars<'_>>, lexer: &mut Lexer) -> Option<()> {
    loop {
        match chars.next()? {
            '\'' => return Some(()),
            '\\' => match chars.next()? {
                escaped @ ('\'' | '"' | '\\' | '?') => lexer.push(escaped),
                escaped => {
                    lexer.push('$');
                    lexer.push('{');
                    lexer.push(escaped);
                }
            },
            ch => lexer.push(ch),
        }
    }
}

/// The delimiter word after `<<` or `<<-`. Quoting any part of it leaves the
/// body unexpanded.
pub(super) fn heredoc_operator(
    chars: &mut Peekable<Chars<'_>>,
    strip_tabs: bool,
) -> Option<Heredoc> {
    while chars.next_if(|ch| *ch == ' ' || *ch == '\t').is_some() {}
    let mut delimiter = String::new();
    let mut quoted = false;
    while let Some(ch) = chars
        .next_if(|ch| !ch.is_whitespace() && !matches!(ch, ';' | '&' | '|' | '<' | '>' | '(' | ')'))
    {
        match ch {
            '\'' => {
                quoted = true;
                loop {
                    match chars.next()? {
                        '\'' => break,
                        ch => delimiter.push(ch),
                    }
                }
            }
            '"' => {
                quoted = true;
                loop {
                    match chars.next()? {
                        '"' => break,
                        '\\' => delimiter.push(chars.next()?),
                        ch => delimiter.push(ch),
                    }
                }
            }
            '\\' => {
                quoted = true;
                delimiter.push(chars.next()?);
            }
            ch => delimiter.push(ch),
        }
    }
    // `<<` with no word is a syntax error: nothing after it can be read.
    (quoted || !delimiter.is_empty()).then_some(Heredoc {
        delimiter,
        strip_tabs,
        expands: !quoted,
    })
}

/// Skip a here-document body up to its delimiter line. An expanding body's
/// `$(…)` and backtick substitutions run, so their commands are read. A body
/// that never meets its delimiter is unreadable: the `<<` may not have been a
/// here-document at all.
pub(super) fn heredoc_body(
    chars: &mut Peekable<Chars<'_>>,
    heredoc: &Heredoc,
    lexer: &mut Lexer,
    dialect: Dialect,
) -> Option<()> {
    let mut line = String::new();
    loop {
        let Some(ch) = chars.next() else {
            let text = if heredoc.strip_tabs {
                line.trim_start_matches('\t')
            } else {
                line.as_str()
            };
            return (text == heredoc.delimiter).then_some(());
        };
        match ch {
            '\n' => {
                let text = if heredoc.strip_tabs {
                    line.trim_start_matches('\t')
                } else {
                    line.as_str()
                };
                if text == heredoc.delimiter {
                    return Some(());
                }
                line.clear();
            }
            // An escaped character, or a joined line, is never the delimiter.
            '\\' if heredoc.expands => {
                line.push('\\');
                if let Some(next) = chars.next() {
                    line.push(next);
                }
            }
            '$' if heredoc.expands && chars.peek() == Some(&'(') => {
                chars.next();
                lexer.commands.extend(posix_substitution(chars, dialect)?);
                line.push_str("$()");
            }
            '`' if heredoc.expands => {
                lexer
                    .commands
                    .extend(posix_reading(&backquoted(chars)?, dialect)?);
                line.push('`');
            }
            ch => line.push(ch),
        }
    }
}

/// Skip a `#` comment, up to the end of its line.
pub(super) fn skip_comment(chars: &mut Peekable<Chars<'_>>) {
    while chars.next_if(|next| *next != '\n').is_some() {}
}

/// The body of a backtick substitution, up to the closing backtick. A
/// backslash keeps its meaning except before `$`, `` ` `` and `\`.
pub(super) fn backquoted(chars: &mut Peekable<Chars<'_>>) -> Option<String> {
    let mut body = String::new();
    loop {
        match chars.next()? {
            '`' => return Some(body),
            '\\' => {
                let escaped = chars.next()?;
                if !matches!(escaped, '$' | '`' | '\\') {
                    body.push('\\');
                }
                body.push(escaped);
            }
            ch => body.push(ch),
        }
    }
}
