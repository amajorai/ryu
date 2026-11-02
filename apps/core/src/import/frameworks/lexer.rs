//! Extract agent constructor calls from JS/TS and Python source.

use super::*;

pub fn extract_code_agents(src: &str, path: &Path, framework: Framework) -> CodeAgents {
    let python = path.extension().and_then(|e| e.to_str()) == Some("py");
    let lexer = Lexer { python };
    let stem = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("agent")
        .to_string();
    let mut calls: Vec<(usize, usize)> = Vec::new();
    for ctor in agent_constructors(framework, python) {
        let mut from = 0;
        while let Some(pos) = src[from..].find(ctor) {
            let start = from + pos;
            from = start + ctor.len();
            // Reject `foo.create_agent(` method-chains on unrelated objects and
            // identifiers that merely end with the constructor name.
            let prev = src[..start].chars().next_back();
            if prev.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_') {
                continue;
            }
            if lexer.in_code(src, start) {
                calls.push((start, start + ctor.len() - 1));
            }
        }
    }
    calls.sort_unstable();
    let mut out = CodeAgents::default();
    for (start, open) in calls {
        let Some(close) = lexer.matching_close(src, open) else {
            continue;
        };
        let mut args = &src[open + 1..close];
        if !python {
            // `new Agent({ ... })` / `createReactAgent({ ... })`: read the
            // options object literal.
            let trimmed = args.trim_start();
            if let Some(stripped) = trimmed.strip_prefix('{') {
                let offset = args.len() - stripped.len() - 1;
                let brace = open + 1 + offset;
                if let Some(end) = lexer.matching_close(src, brace) {
                    args = &src[brace + 1..end];
                }
            }
        }
        let separator = if python { '=' } else { ':' };
        let value_of = |key: &str| lexer.top_level_value(args, key, separator);
        let instructions = instruction_keys(framework, python)
            .iter()
            .find_map(|key| value_of(key))
            .and_then(|value| lexer.resolve_string(src, value));
        let assigned = assigned_name(src, start);
        let name = value_of("name")
            .or_else(|| value_of("id"))
            .and_then(|v| lexer.resolve_string(src, v))
            .map(|n| n.trim().to_string())
            .filter(|n| !n.is_empty())
            .or(assigned.clone())
            .unwrap_or_else(|| format!("{stem}-{}", out.agents.len() + 1));
        let Some(instructions) = instructions.filter(|i| !i.trim().is_empty()) else {
            out.unresolved.push(name);
            continue;
        };
        let model = value_of("model")
            .or_else(|| value_of("llm"))
            .and_then(|v| lexer.model_ref(src, v));
        let description = value_of("description").and_then(|v| lexer.resolve_string(src, v));
        out.agents.push(CodeAgent {
            name,
            description,
            instructions: instructions.trim().to_string(),
            model,
        });
    }
    out
}

/// `const foo = new Agent(` / `foo = create_agent(` → `foo`.
pub(super) fn assigned_name(src: &str, call_start: usize) -> Option<String> {
    let before = src[..call_start].trim_end();
    let before = before.strip_suffix('=')?.trim_end();
    if before.ends_with(['=', '!', '<', '>']) {
        return None;
    }
    let before = before
        .rsplit_once(':')
        .filter(|(_, ty)| !ty.contains('\n'))
        .map(|(lhs, _)| lhs.trim_end())
        .unwrap_or(before);
    let ident: String = before
        .chars()
        .rev()
        .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    (!ident.is_empty() && !ident.chars().next().unwrap_or('0').is_ascii_digit()).then_some(ident)
}

/// A tiny lexer that understands enough JS/TS and Python string and comment
/// syntax to find call boundaries and static string literals.
pub(super) struct Lexer {
    python: bool,
}

impl Lexer {
    /// Advance past one string literal starting at `i` (which must be a quote,
    /// or a Python prefix before one). Returns the index after the literal.
    fn skip_string(&self, b: &[u8], i: usize) -> Option<usize> {
        let mut i = i;
        if self.python {
            while i < b.len()
                && matches!(b[i], b'r' | b'R' | b'u' | b'U' | b'b' | b'B' | b'f' | b'F')
            {
                i += 1;
            }
        }
        let quote = *b.get(i)?;
        if !matches!(quote, b'"' | b'\'' | b'`') {
            return None;
        }
        let triple = self.python && b.get(i + 1) == Some(&quote) && b.get(i + 2) == Some(&quote);
        let mut j = if triple { i + 3 } else { i + 1 };
        while j < b.len() {
            if b[j] == b'\\' {
                j += 2;
                continue;
            }
            if b[j] == quote {
                if !triple {
                    return Some(j + 1);
                }
                if b.get(j + 1) == Some(&quote) && b.get(j + 2) == Some(&quote) {
                    return Some(j + 3);
                }
            }
            if b[j] == b'\n' && !triple && quote != b'`' {
                return Some(j);
            }
            j += 1;
        }
        Some(b.len())
    }

    fn comment_end(&self, b: &[u8], i: usize) -> Option<usize> {
        if self.python {
            if b[i] == b'#' {
                return Some(
                    b[i..]
                        .iter()
                        .position(|c| *c == b'\n')
                        .map_or(b.len(), |p| i + p),
                );
            }
            return None;
        }
        if b[i] == b'/' && b.get(i + 1) == Some(&b'/') {
            return Some(
                b[i..]
                    .iter()
                    .position(|c| *c == b'\n')
                    .map_or(b.len(), |p| i + p),
            );
        }
        if b[i] == b'/' && b.get(i + 1) == Some(&b'*') {
            return Some(
                b[i + 2..]
                    .windows(2)
                    .position(|w| w == b"*/")
                    .map_or(b.len(), |p| i + 2 + p + 2),
            );
        }
        None
    }

    fn is_quote(b: u8) -> bool {
        matches!(b, b'"' | b'\'' | b'`')
    }

    /// True when byte offset `pos` is outside strings and comments.
    fn in_code(&self, src: &str, pos: usize) -> bool {
        let b = src.as_bytes();
        let mut i = 0;
        while i < pos {
            if let Some(end) = self.comment_end(b, i) {
                if end > pos {
                    return false;
                }
                i = end.max(i + 1);
                continue;
            }
            if Self::is_quote(b[i]) {
                let end = self.skip_string(b, i).unwrap_or(b.len());
                if end > pos {
                    return false;
                }
                i = end;
                continue;
            }
            i += 1;
        }
        true
    }

    /// Index of the bracket closing the one at `open`.
    fn matching_close(&self, src: &str, open: usize) -> Option<usize> {
        let b = src.as_bytes();
        let mut depth = 0usize;
        let mut i = open;
        while i < b.len() {
            if let Some(end) = self.comment_end(b, i) {
                i = end.max(i + 1);
                continue;
            }
            match b[i] {
                c if Self::is_quote(c) => {
                    i = self.skip_string(b, i)?;
                    continue;
                }
                b'(' | b'[' | b'{' => depth += 1,
                b')' | b']' | b'}' => {
                    depth = depth.checked_sub(1)?;
                    if depth == 0 {
                        return Some(i);
                    }
                }
                _ => {}
            }
            i += 1;
        }
        None
    }

    /// The source text of `key`'s value at the top level of `args`
    /// (`key=value` in Python calls, `key: value` in JS objects). Shorthand
    /// properties (`{ instructions }`) resolve to the identifier itself.
    fn top_level_value<'a>(&self, args: &'a str, key: &str, sep: char) -> Option<&'a str> {
        let b = args.as_bytes();
        let mut depth = 0usize;
        let mut i = 0;
        let mut at_item_start = true;
        while i < b.len() {
            if let Some(end) = self.comment_end(b, i) {
                i = end.max(i + 1);
                continue;
            }
            let c = b[i];
            if Self::is_quote(c) {
                i = self.skip_string(b, i).unwrap_or(b.len());
                at_item_start = false;
                continue;
            }
            match c {
                b'(' | b'[' | b'{' => {
                    depth += 1;
                    at_item_start = false;
                }
                b')' | b']' | b'}' => depth = depth.saturating_sub(1),
                b',' if depth == 0 => at_item_start = true,
                c if c.is_ascii_whitespace() => {}
                _ if depth == 0 && at_item_start => {
                    at_item_start = false;
                    let rest = &args[i..];
                    let ident_len = rest
                        .bytes()
                        .take_while(|c| c.is_ascii_alphanumeric() || *c == b'_' || *c == b'$')
                        .count();
                    if &rest[..ident_len] == key {
                        let after = rest[ident_len..].trim_start();
                        if let Some(value) = after.strip_prefix(sep) {
                            if !value.starts_with('=') {
                                return Some(value.trim_start());
                            }
                        }
                        if sep == ':' && (after.starts_with(',') || after.is_empty()) {
                            return Some(&rest[..ident_len]);
                        }
                    }
                }
                _ => {}
            }
            i += 1;
        }
        None
    }

    /// A static string value: a literal (or concatenation of literals), or an
    /// identifier bound to one elsewhere in the same file.
    fn resolve_string(&self, src: &str, value: &str) -> Option<String> {
        if let Some(s) = self.string_value(value) {
            return Some(s);
        }
        let ident: String = value
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '$')
            .collect();
        let after = value[ident.len()..].trim_start();
        if ident.is_empty() || !(after.is_empty() || after.starts_with([',', '\n', ')', '}'])) {
            return None;
        }
        self.binding_value(src, &ident)
    }

    /// Find `IDENT = <literal>` (optionally `const`/`let`/typed) in `src`.
    fn binding_value(&self, src: &str, ident: &str) -> Option<String> {
        let mut from = 0;
        while let Some(pos) = src[from..].find(ident) {
            let start = from + pos;
            from = start + ident.len();
            let prev = src[..start].chars().next_back();
            if prev.is_some_and(|c| c.is_ascii_alphanumeric() || c == '_' || c == '$' || c == '.') {
                continue;
            }
            let mut rest = src[from..].trim_start();
            if let Some(typed) = rest.strip_prefix(':') {
                // `NAME: str = "..."` / `const NAME: string = "..."`
                rest = typed.trim_start_matches(|c: char| c != '=' && c != '\n');
            }
            let Some(value) = rest.strip_prefix('=') else {
                continue;
            };
            if value.starts_with(['=', '>']) || !self.in_code(src, start) {
                continue;
            }
            if let Some(s) = self.string_value(value.trim_start()) {
                return Some(s);
            }
        }
        None
    }

    /// Decode a literal or literal concatenation at the start of `value`.
    fn string_value(&self, value: &str) -> Option<String> {
        let mut text = value.trim_start();
        let mut wrapped = false;
        if self.python {
            if let Some(inner) = text.strip_prefix('(') {
                text = inner.trim_start();
                wrapped = true;
            }
        }
        let mut out = String::new();
        let mut parts = 0;
        loop {
            let (part, len) = self.decode_literal(text)?;
            out.push_str(&part);
            parts += 1;
            text = text[len..].trim_start();
            if !self.python {
                if let Some(rest) = text.strip_prefix('+') {
                    text = rest.trim_start();
                    continue;
                }
            } else if text.starts_with(['"', '\'']) || (wrapped && text.starts_with(['r', 'R'])) {
                continue;
            }
            break;
        }
        if wrapped {
            text.strip_prefix(')')?;
        }
        (parts > 0).then_some(out)
    }

    /// Decode one literal at the start of `text`, returning `(value, byte_len)`.
    /// f-strings and template literals with substitutions are not static.
    fn decode_literal(&self, text: &str) -> Option<(String, usize)> {
        let b = text.as_bytes();
        let mut i = 0;
        let mut raw = false;
        if self.python {
            while i < b.len()
                && matches!(b[i], b'r' | b'R' | b'u' | b'U' | b'f' | b'F' | b'b' | b'B')
            {
                if matches!(b[i], b'f' | b'F' | b'b' | b'B') {
                    return None;
                }
                raw |= matches!(b[i], b'r' | b'R');
                i += 1;
            }
        }
        let quote = *b.get(i)?;
        if !Self::is_quote(quote) || (self.python && quote == b'`') {
            return None;
        }
        let end = self.skip_string(b, i)?;
        let triple = self.python && b.get(i + 1) == Some(&quote) && b.get(i + 2) == Some(&quote);
        let delim = if triple { 3 } else { 1 };
        if end < i + 2 * delim || b[end - 1] != quote {
            return None;
        }
        let body = &text[i + delim..end - delim];
        if quote == b'`' && body.contains("${") {
            return None;
        }
        let value = if raw {
            body.to_string()
        } else {
            unescape(body)
        };
        let value = if triple || quote == b'`' {
            dedent(&value)
        } else {
            value
        };
        Some((value, end))
    }

    /// `openai("gpt-4o")` → `openai/gpt-4o`; `"openai:gpt-4o"` → `openai/gpt-4o`;
    /// `ChatAnthropic(model="claude-x")` → `anthropic/claude-x`;
    /// `init_chat_model("gpt-4o", model_provider="openai")` → `openai/gpt-4o`.
    fn model_ref(&self, src: &str, value: &str) -> Option<String> {
        if let Some(s) = self.resolve_string(src, value) {
            let s = s.trim();
            return (!s.is_empty()).then(|| s.replacen(':', "/", 1));
        }
        let value = value.strip_prefix("new ").unwrap_or(value).trim_start();
        let ident: String = value
            .chars()
            .take_while(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '.')
            .collect();
        let rest = value[ident.len()..].trim_start();
        let open = value.len() - rest.len();
        if !rest.starts_with('(') {
            return None;
        }
        let close = self.matching_close(value, open)?;
        let mut args = value[open + 1..close].trim();
        if let Some(object) = args.strip_prefix('{').and_then(|a| a.strip_suffix('}')) {
            args = object;
        }
        let sep = if self.python { '=' } else { ':' };
        let first = self.string_value(args).or_else(|| {
            ["model", "model_name", "modelName"]
                .iter()
                .find_map(|k| self.top_level_value(args, k, sep))
                .and_then(|v| self.resolve_string(src, v))
        })?;
        let first = first.trim().replacen(':', "/", 1);
        if first.contains('/') {
            return Some(first);
        }
        let provider = self
            .top_level_value(args, "model_provider", sep)
            .and_then(|v| self.string_value(v))
            .or_else(|| provider_for_constructor(ident.rsplit('.').next().unwrap_or(&ident)))?;
        Some(format!("{provider}/{first}"))
    }
}
