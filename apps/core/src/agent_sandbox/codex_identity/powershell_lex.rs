use super::*;

use std::iter::Peekable;
use std::str::Chars;

/// Simple commands of a PowerShell script, or `None` when a string,
/// here-string, `$(…)` subexpression or block comment is never closed.
pub(super) fn powershell_commands(script: &str) -> Option<Vec<Vec<String>>> {
    let script = script.chars().map(powershell_char).collect::<String>();
    let mut lexer = Lexer::default();
    powershell_lex(&mut script.chars().peekable(), &mut lexer, false)?;
    Some(lexer.finish())
}

/// PowerShell reads typographic quotes as quotes and dashes as `-`.
pub(super) fn powershell_char(ch: char) -> char {
    match ch {
        '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
        '\u{201C}' | '\u{201D}' | '\u{201E}' => '"',
        '\u{2013}' | '\u{2014}' | '\u{2015}' => '-',
        ch => ch,
    }
}

/// The body of a here-string after its opening `@'` or `@"`. It ends only at
/// a line that starts with the same quote and `@`, so quotes inside it are
/// text; a double-quoted one takes backtick escapes and runs `$(…)`.
pub(super) fn powershell_here_string(
    chars: &mut Peekable<Chars<'_>>,
    lexer: &mut Lexer,
    quote: char,
) -> Option<()> {
    let mut line_start = false;
    loop {
        let ch = chars.next()?;
        if line_start && ch == quote && chars.next_if_eq(&'@').is_some() {
            return Some(());
        }
        line_start = ch == '\n';
        match ch {
            '`' if quote == '"' => lexer.push(chars.next()?),
            '$' if quote == '"' && chars.peek() == Some(&'(') => {
                chars.next();
                powershell_subexpression(chars, lexer)?;
            }
            ch => lexer.push(ch),
        }
    }
}

/// Reads PowerShell statements into `lexer` until the script ends or, for a
/// `$(…)` subexpression (`nested`), until the `)` that closes it. Single-quoted
/// strings are literal (`''` is a quote), double-quoted strings take backtick
/// escapes and run `$(…)`, here-strings (`@'…'@`, `@"…"@`) end only at their
/// closing line, a backtick escapes the next character, `#` starting a word
/// and `<# … #>` are comments, and `;`, `|`, `&`, newlines, parentheses and
/// script-block braces separate commands, so a block passed as an argument
/// (`ForEach-Object { … }`) is read as commands.
pub(super) fn powershell_lex(
    chars: &mut Peekable<Chars<'_>>,
    lexer: &mut Lexer,
    nested: bool,
) -> Option<()> {
    let mut depth = 0_usize;
    while let Some(ch) = chars.next() {
        match ch {
            '@' if !lexer.in_word && matches!(chars.peek(), Some('\'' | '"')) => {
                let quote = chars.next()?;
                lexer.quote();
                powershell_here_string(chars, lexer, quote)?;
            }
            '\'' => {
                lexer.quote();
                loop {
                    match chars.next()? {
                        '\'' if chars.next_if_eq(&'\'').is_some() => lexer.push('\''),
                        '\'' => break,
                        ch => lexer.push(ch),
                    }
                }
            }
            '"' => {
                lexer.quote();
                loop {
                    match chars.next()? {
                        '`' => lexer.push(chars.next()?),
                        '"' if chars.next_if_eq(&'"').is_some() => lexer.push('"'),
                        '"' => break,
                        '$' if chars.peek() == Some(&'(') => {
                            chars.next();
                            powershell_subexpression(chars, lexer)?;
                        }
                        ch => lexer.push(ch),
                    }
                }
            }
            '`' => match chars.next() {
                // A line continuation.
                Some('\n') | None => {}
                Some('\r') => {
                    chars.next_if_eq(&'\n');
                }
                Some(next) => lexer.push(next),
            },
            '$' if chars.peek() == Some(&'(') => {
                chars.next();
                powershell_subexpression(chars, lexer)?;
            }
            // `${name}` is a variable, not a script block.
            '$' if chars.peek() == Some(&'{') => {
                lexer.push('$');
                loop {
                    let next = chars.next()?;
                    lexer.push(next);
                    if next == '}' {
                        break;
                    }
                }
            }
            '#' if !lexer.in_word => skip_comment(chars),
            '<' if chars.peek() == Some(&'#') => {
                chars.next();
                let mut previous = ' ';
                loop {
                    let next = chars.next()?;
                    if previous == '#' && next == '>' {
                        break;
                    }
                    previous = next;
                }
            }
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
            ';' | '&' | '|' | '{' | '}' | '\n' | '\r' => lexer.end_command(),
            '>' | '<' => lexer.redirect(chars),
            ch if ch.is_whitespace() => lexer.end_word(),
            ch => lexer.push(ch),
        }
    }
    (!nested).then_some(())
}

/// A PowerShell `$(…)` subexpression: its statements run on their own.
pub(super) fn powershell_subexpression(
    chars: &mut Peekable<Chars<'_>>,
    lexer: &mut Lexer,
) -> Option<()> {
    let mut inner = Lexer::default();
    powershell_lex(chars, &mut inner, true)?;
    lexer.substitute(inner.finish());
    Some(())
}
