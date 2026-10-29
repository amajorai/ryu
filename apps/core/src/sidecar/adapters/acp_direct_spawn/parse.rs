use super::*;

pub(super) fn is_cmd(command: &Path) -> bool {
    command
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            name.eq_ignore_ascii_case("cmd") || name.eq_ignore_ascii_case("cmd.exe")
        })
}

pub(super) fn is_npx(token: &str) -> bool {
    ["npx", "npx.cmd", "npx.exe"]
        .iter()
        .any(|name| token.eq_ignore_ascii_case(name))
}

/// The launched command line as tokens, unwrapping `cmd /c …` whether its
/// command is split into arguments or passed as one command-line string.
pub(super) fn command_tokens(stdio: &McpServerStdio) -> Option<Vec<String>> {
    if !is_cmd(&stdio.command) {
        return Some(
            std::iter::once(stdio.command.to_string_lossy().into_owned())
                .chain(stdio.args.iter().cloned())
                .collect(),
        );
    }
    let rest: Vec<&String> = stdio
        .args
        .iter()
        .skip_while(|arg| {
            arg.len() == 2
                && arg.starts_with('/')
                && matches!(
                    arg.as_bytes()[1].to_ascii_lowercase(),
                    b'c' | b'd' | b's' | b'q'
                )
        })
        .collect();
    Some(match rest.as_slice() {
        [single] => shell_words::split(single).ok()?,
        many => many.iter().map(|arg| (*arg).clone()).collect(),
    })
}

/// Recover `npx -y <spec> args…` from the shapes Ryu declares:
/// `npx -y spec …`, `cmd /c [set K=V&&]… npx -y spec …` (split into tokens), and
/// `cmd /d /s /c "npx -y spec …"` (one command-line argument).
pub(super) fn parse_npx_invocation(stdio: &McpServerStdio) -> Option<NpxInvocation> {
    parse_npx_tokens(&command_tokens(stdio)?)
}

pub(super) fn parse_npx_tokens(tokens: &[String]) -> Option<NpxInvocation> {
    let mut env = Vec::new();
    let mut index = 0;
    while tokens
        .get(index)
        .is_some_and(|token| token.eq_ignore_ascii_case("set"))
    {
        let assignment = tokens.get(index + 1)?;
        index += 2;
        let assignment = match assignment.strip_suffix("&&") {
            Some(stripped) => stripped,
            None if tokens.get(index).map(String::as_str) == Some("&&") => {
                index += 1;
                assignment.as_str()
            }
            None => return None,
        };
        let (name, value) = assignment.split_once('=')?;
        if name.is_empty()
            || !name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
        {
            return None;
        }
        env.push((name.to_owned(), value.to_owned()));
    }
    if !is_npx(tokens.get(index)?) {
        return None;
    }
    index += 1;
    let mut saw_yes = false;
    while let Some(token) = tokens.get(index) {
        match token.as_str() {
            "-y" | "--yes" => saw_yes = true,
            "--" => {
                index += 1;
                break;
            }
            flag if flag.starts_with('-') => return None,
            _ => break,
        }
        index += 1;
    }
    let spec = tokens.get(index)?.clone();
    // Without `-y` npx may prompt; that is not a shape Ryu declares. Codex
    // identity does not depend on this parser (see `agent_sandbox`).
    if !saw_yes || spec.starts_with('-') || package_name(&spec).is_none() {
        return None;
    }
    // Anything shell-like after the spec means cmd.exe was doing more than
    // launching one package.
    let args = tokens[index + 1..].to_vec();
    if args
        .iter()
        .any(|arg| arg.contains("&&") || arg == "|" || arg == "&" || arg.starts_with('>'))
    {
        return None;
    }
    Some(NpxInvocation { env, spec, args })
}

/// `@scope/name@1.2` → `@scope/name`, `name@latest` → `name`.
pub(crate) fn package_name(spec: &str) -> Option<&str> {
    let search_from = usize::from(spec.starts_with('@'));
    let name = match spec[search_from..].find('@') {
        Some(at) => &spec[..search_from + at],
        None => spec,
    };
    let valid = !name.is_empty()
        && name.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'@' | b'/' | b'-' | b'_' | b'.')
        })
        && (!name.starts_with('@') || name.contains('/'));
    valid.then_some(name)
}

pub(super) fn spec_follows_latest(spec: &str) -> bool {
    package_name(spec).is_some_and(|name| spec == name || spec == format!("{name}@latest"))
}

pub(super) fn spec_key(spec: &str) -> String {
    spec.chars()
        .map(|char| {
            if char.is_ascii_alphanumeric() || char == '.' || char == '-' {
                char
            } else {
                '_'
            }
        })
        .collect()
}
