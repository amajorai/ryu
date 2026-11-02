//! CommonMark to Slack mrkdwn, and splitting long messages under the Web API cap.

// ─── CommonMark → Slack mrkdwn ─────────────────────────────────────────────────

/// Split a Slack message without breaking UTF-8 or exceeding the Web API cap.
pub(super) fn split_slack_text(input: &str, max_chars: usize) -> Vec<String> {
    if max_chars == 0 {
        return vec![input.to_string()];
    }
    let chars: Vec<char> = input.chars().collect();
    if chars.is_empty() {
        return vec![String::new()];
    }
    let mut parts = Vec::new();
    let mut start = 0;
    while chars.len() - start > max_chars {
        let mut end = start + max_chars;
        for index in (start + 1..=end).rev() {
            if chars[index - 1] == '\n' {
                end = index;
                break;
            }
        }
        parts.push(chars[start..end].iter().collect());
        start = end;
        while chars.get(start) == Some(&'\n') {
            start += 1;
        }
    }
    parts.push(chars[start..].iter().collect());
    parts
}

/// How deeply emphasis may nest before the converter stops interpreting it.
/// Pathological input ("`*`" a thousand times) should degrade to literal text,
/// not to unbounded work.
pub(super) const MAX_EMPHASIS_NESTING: usize = 8;

/// Convert CommonMark to Slack's mrkdwn.
///
/// The mapping, and what it deliberately cannot do:
///
/// | CommonMark        | mrkdwn        | note                                  |
/// |-------------------|---------------|---------------------------------------|
/// | `**b**` / `__b__` | `*b*`         | Slack's bold is a SINGLE asterisk      |
/// | `*i*`             | `_i_`         | …which is why italics have to move     |
/// | `~~s~~`           | `~s~`         |                                        |
/// | `[t](u)`          | `<u\|t>`      |                                        |
/// | `# H`             | `*H*`         | no headings exist; emphasis stands in  |
/// | `- x`             | `• x`         | indentation preserved                  |
/// | table rows        | verbatim      | no table syntax exists; pipes stay     |
///
/// Fenced blocks and inline code spans pass through untouched (their content is
/// not markup), and `&`, `<`, `>` are escaped everywhere else because Slack
/// otherwise reads them as its own control syntax — the escaping happens as text
/// is emitted, so the `<url|label>` links this function *generates* survive it.
pub fn to_mrkdwn(markdown: &str) -> String {
    let mut out = String::with_capacity(markdown.len());
    let mut in_fence = false;

    for (index, line) in markdown.lines().enumerate() {
        if index > 0 {
            out.push('\n');
        }
        let trimmed = line.trim_start();

        if trimmed.starts_with("```") {
            in_fence = !in_fence;
            // Drop the info string: Slack has no syntax highlighting and would
            // render "rust" as the block's first line.
            out.push_str("```");
            continue;
        }
        if in_fence {
            out.push_str(&escape(line));
            continue;
        }

        // A heading has no mrkdwn equivalent, so it becomes bold. Emphasis INSIDE
        // it is dropped rather than nested — Slack does not render `*a *b* c*`.
        // CommonMark requires whitespace after the `#` run, and so do we: without
        // that rule a message about `#general` would come out emboldened.
        if let Some(heading) = heading_body(trimmed) {
            let text = heading.trim();
            if !text.is_empty() {
                out.push('*');
                out.push_str(&convert_inline(text).replace('*', ""));
                out.push('*');
                continue;
            }
        }

        // Bullets: keep the indentation (Slack nests on it) and use a real
        // bullet, which is what `-`/`*` would have rendered as.
        let indent = &line[..line.len() - trimmed.len()];
        if let Some(item) = bullet_body(trimmed) {
            out.push_str(indent);
            out.push_str("• ");
            out.push_str(&convert_inline(item));
            continue;
        }

        // Block quotes use the same `>` in mrkdwn, so the marker is passed
        // through literally instead of being escaped into `&gt;`.
        if let Some(quoted) = trimmed.strip_prefix('>') {
            out.push_str(indent);
            out.push('>');
            out.push_str(&convert_inline(quoted));
            continue;
        }

        out.push_str(&convert_inline(line));
    }

    // `lines()` drops a trailing newline; keep it so a reply's spacing survives.
    if markdown.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// The text of an ATX heading (`## Results`), or `None` when the line is not
/// one. The whitespace after the `#` run is required, which is what keeps a
/// channel reference (`#general`) from being read as a heading.
pub(super) fn heading_body(trimmed: &str) -> Option<&str> {
    let rest = trimmed.trim_start_matches('#');
    if rest.len() == trimmed.len() {
        return None;
    }
    rest.starts_with([' ', '\t']).then(|| rest.trim_start())
}

/// The text of a `-`/`*`/`+` bullet, or `None` when the line is not one. The
/// space is required, so "3 * 4" and "**bold**" are not mistaken for bullets.
pub(super) fn bullet_body(trimmed: &str) -> Option<&str> {
    let mut chars = trimmed.chars();
    match (chars.next(), chars.next()) {
        (Some('-' | '*' | '+'), Some(' ')) => Some(trimmed[2..].trim_start()),
        _ => None,
    }
}

/// Escape the three characters Slack reads as control syntax in message text.
pub(super) fn escape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            _ => out.push(ch),
        }
    }
    out
}

/// Convert one line's inline markup.
///
/// A SINGLE left-to-right pass, which is the whole point: converting `**b**` to
/// `*b*` and then converting single asterisks to `_` in a second pass would undo
/// the first one. Openers record where their closer sits, so the scan emits the
/// right replacement when it arrives there without ever re-reading its own output.
pub(super) fn convert_inline(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    // (index of the closing marker, what to emit for it, marker length).
    let mut closers: Vec<(usize, &str, usize)> = Vec::new();
    let mut i = 0;

    while i < chars.len() {
        if let Some(&(index, replacement, len)) = closers.last() {
            if i == index {
                out.push_str(replacement);
                i += len;
                closers.pop();
                continue;
            }
        }

        let ch = chars[i];
        match ch {
            // Code spans are not markup: copy through (escaped) to the closer.
            '`' => match find_marker(&chars, i + 1, "`") {
                Some(end) => {
                    out.push('`');
                    out.push_str(&escape(&slice(&chars, i + 1, end)));
                    out.push('`');
                    i = end + 1;
                }
                None => {
                    out.push('`');
                    i += 1;
                }
            },
            '[' => match parse_link(&chars, i) {
                Some((label, url, next)) => {
                    // Escaping happens on the pieces, BEFORE the link syntax is
                    // written, so this generated `<…|…>` is not escaped away.
                    out.push('<');
                    out.push_str(&escape(&url));
                    if !label.is_empty() {
                        out.push('|');
                        out.push_str(&escape(&label));
                    }
                    out.push('>');
                    i = next;
                }
                None => {
                    out.push('[');
                    i += 1;
                }
            },
            '*' | '_' | '~' => match open_emphasis(&chars, i, closers.len()) {
                Some((replacement, len, close_at)) => {
                    out.push_str(replacement);
                    closers.push((close_at, replacement, len));
                    i += len;
                }
                None => {
                    out.push(ch);
                    i += 1;
                }
            },
            '&' => {
                out.push_str("&amp;");
                i += 1;
            }
            '<' => {
                out.push_str("&lt;");
                i += 1;
            }
            '>' => {
                out.push_str("&gt;");
                i += 1;
            }
            _ => {
                out.push(ch);
                i += 1;
            }
        }
    }
    out
}

/// Classify an emphasis marker at `start`, returning what to emit for it, how
/// many characters it spans, and where its closer sits — or `None` when it has
/// no closer (a lone `*` in prose is text, not markup).
pub(super) fn open_emphasis(
    chars: &[char],
    start: usize,
    depth: usize,
) -> Option<(&'static str, usize, usize)> {
    if depth >= MAX_EMPHASIS_NESTING {
        return None;
    }
    let doubled = chars.get(start + 1) == Some(&chars[start]);
    let (marker, len, replacement) = match (chars[start], doubled) {
        // Bold in CommonMark is doubled; in mrkdwn it is a single asterisk.
        ('*', true) => ("**", 2, "*"),
        ('_', true) => ("__", 2, "*"),
        ('~', true) => ("~~", 2, "~"),
        // A single asterisk is CommonMark's italic, which mrkdwn spells `_`.
        ('*', false) => ("*", 1, "_"),
        // A single underscore already means italic to Slack; leave it alone.
        ('_', false) => ("_", 1, "_"),
        // A single tilde already means strikethrough to Slack.
        ('~', false) => ("~", 1, "~"),
        _ => return None,
    };
    // Emphasis cannot open on whitespace ("2 * 3" is arithmetic) and must close.
    if matches!(chars.get(start + len), None | Some(' ') | Some('\t')) {
        return None;
    }
    let close_at = find_marker(chars, start + len, marker)?;
    Some((replacement, len, close_at))
}

/// Index of the next occurrence of `marker` at or after `from`.
pub(super) fn find_marker(chars: &[char], from: usize, marker: &str) -> Option<usize> {
    let needle: Vec<char> = marker.chars().collect();
    (from..chars.len().saturating_sub(needle.len() - 1))
        .find(|&i| chars[i..i + needle.len()] == needle[..])
}

/// Parse `[label](url)` starting at `start`, returning `(label, url, index after
/// the link)`. An image (`![alt](url)`) parses the same way — Slack unfurls the
/// URL, which is the closest thing it has to an inline image.
pub(super) fn parse_link(chars: &[char], start: usize) -> Option<(String, String, usize)> {
    let label_end = (start + 1..chars.len()).find(|&i| chars[i] == ']')?;
    if chars.get(label_end + 1) != Some(&'(') {
        return None;
    }
    let url_end = (label_end + 2..chars.len()).find(|&i| chars[i] == ')')?;
    let url = slice(chars, label_end + 2, url_end);
    if url.trim().is_empty() {
        return None;
    }
    Some((slice(chars, start + 1, label_end), url, url_end + 1))
}

/// `chars[a..b]` as a `String`.
pub(super) fn slice(chars: &[char], a: usize, b: usize) -> String {
    chars[a..b].iter().collect()
}
