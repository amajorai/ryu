//! HTML to Markdown for connector imports (web pages, Confluence pages).
//!
//! `document.parse`'s builtin floor tag-strips HTML to plain text, which loses
//! the headings, lists, links, and tables a Space page should keep. Connector
//! imports already hold the HTML in memory, so they convert it here first and
//! hand the Space pipeline a Markdown page instead.
//!
//! This is a lenient single-pass converter, not a DOM: it tracks the open-element
//! stack only as far as rendering needs (list nesting, `pre`, tables, links), drops
//! non-content elements (`script`, `style`, `nav`, forms, ...), and never fetches
//! anything a page references.

/// Elements whose whole subtree is dropped.
const DROPPED: &[&str] = &[
    "script", "style", "noscript", "template", "svg", "canvas", "iframe", "object", "form",
    "button", "select", "textarea", "nav", "header", "footer", "aside", "head",
];

/// Elements that start a new block.
const BLOCKS: &[&str] = &[
    "p",
    "div",
    "section",
    "article",
    "main",
    "body",
    "html",
    "figure",
    "figcaption",
    "address",
    "details",
    "summary",
    "dl",
    "dt",
    "dd",
    "fieldset",
    "center",
];

const VOID: &[&str] = &[
    "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source",
    "track", "wbr",
];

#[derive(Default)]
struct Converter {
    out: String,
    /// Inline text collected for the current block.
    line: String,
    /// `Some(counter)` for an ordered list, `None` for a bulleted one.
    lists: Vec<Option<u32>>,
    quote_depth: usize,
    pre_depth: usize,
    code_depth: usize,
    last_was_list_item: bool,
    pre_buffer: String,
    pre_language: Option<String>,
    drop_depth: usize,
    dropped_stack: Vec<String>,
    links: Vec<Option<String>>,
    table: Option<Vec<Vec<String>>>,
    cell: Option<String>,
    base_url: Option<url::Url>,
}

fn decode_entities(text: &str) -> String {
    if !text.contains('&') {
        return text.to_owned();
    }
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(start) = rest.find('&') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let end = after
            .char_indices()
            .take(12)
            .find(|(_, ch)| *ch == ';')
            .map(|(index, _)| index);
        let Some(end) = end else {
            out.push('&');
            rest = after;
            continue;
        };
        let entity = &after[..end];
        let decoded = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            "nbsp" => Some(' '),
            "mdash" => Some('\u{2014}'),
            "ndash" => Some('\u{2013}'),
            "hellip" => Some('\u{2026}'),
            "rsquo" => Some('\u{2019}'),
            "lsquo" => Some('\u{2018}'),
            "rdquo" => Some('\u{201d}'),
            "ldquo" => Some('\u{201c}'),
            "copy" => Some('\u{a9}'),
            _ => entity
                .strip_prefix("#x")
                .or_else(|| entity.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| entity.strip_prefix('#').and_then(|dec| dec.parse().ok()))
                .and_then(char::from_u32),
        };
        match decoded {
            Some(ch) => {
                out.push(ch);
                rest = &after[end + 1..];
            }
            None => {
                out.push('&');
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

fn attribute(tag: &str, name: &str) -> Option<String> {
    let lower = tag.to_ascii_lowercase();
    let mut search = 0;
    while let Some(found) = lower[search..].find(name) {
        let at = search + found;
        search = at + name.len();
        let before_ok = at == 0
            || lower[..at]
                .chars()
                .last()
                .is_some_and(|ch| ch.is_whitespace());
        let rest = tag[at + name.len()..].trim_start();
        if !before_ok || !rest.starts_with('=') {
            continue;
        }
        let value = rest[1..].trim_start();
        let (quote, body) = match value.chars().next() {
            Some(q @ ('"' | '\'')) => (Some(q), &value[1..]),
            _ => (None, value),
        };
        let end = match quote {
            Some(q) => body.find(q).unwrap_or(body.len()),
            None => body
                .find(|ch: char| ch.is_whitespace() || ch == '>')
                .unwrap_or(body.len()),
        };
        return Some(decode_entities(&body[..end]));
    }
    None
}

fn escape_inline(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for ch in text.chars() {
        if matches!(ch, '\\' | '`' | '*' | '_' | '[' | ']') {
            out.push('\\');
        }
        out.push(ch);
    }
    out
}

impl Converter {
    fn resolve(&self, href: &str) -> Option<String> {
        let trimmed = href.trim();
        let lower = trimmed.to_ascii_lowercase();
        if trimmed.is_empty()
            || trimmed.starts_with('#')
            || lower.starts_with("javascript:")
            || lower.starts_with("vbscript:")
            || lower.starts_with("data:")
        {
            return None;
        }
        match &self.base_url {
            Some(base) => base.join(trimmed).ok().map(String::from),
            None => Some(trimmed.to_owned()),
        }
    }

    fn push_inline(&mut self, text: &str) {
        if let Some(cell) = self.cell.as_mut() {
            cell.push_str(text);
        } else {
            self.line.push_str(text);
        }
    }

    fn flush(&mut self) {
        let collapsed = self
            .line
            .split('\n')
            .map(|line| line.split_whitespace().collect::<Vec<_>>().join(" "))
            .collect::<Vec<_>>()
            .join("\n");
        let text = collapsed.trim();
        self.line.clear();
        if text.is_empty() {
            return;
        }
        let mut block = String::new();
        if let Some(depth) = self.lists.len().checked_sub(1) {
            let indent = "  ".repeat(depth);
            block.push_str(&indent);
            block.push_str(text);
        } else {
            block.push_str(text);
        }
        self.emit(&block, !self.lists.is_empty());
    }

    /// Append a block. Consecutive items of one list are separated by a single
    /// newline; everything else by a blank line.
    fn emit(&mut self, block: &str, list_item: bool) {
        let quoted = if self.quote_depth > 0 {
            let prefix = "> ".repeat(self.quote_depth);
            block
                .lines()
                .map(|line| format!("{prefix}{line}"))
                .collect::<Vec<_>>()
                .join("\n")
        } else {
            block.to_owned()
        };
        if !self.out.is_empty() {
            let tight = list_item && self.last_was_list_item;
            self.out.push_str(if tight { "\n" } else { "\n\n" });
        }
        self.out.push_str(&quoted);
        self.last_was_list_item = list_item;
    }

    fn open(&mut self, name: &str, raw: &str) {
        match name {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                self.flush();
                let level = name[1..].parse::<usize>().unwrap_or(1);
                self.line.push_str(&"#".repeat(level));
                self.line.push(' ');
            }
            "br" => self.push_inline("\n"),
            "hr" => {
                self.flush();
                self.emit("---", false);
            }
            "strong" | "b" => self.push_inline("**"),
            "em" | "i" => self.push_inline("*"),
            "del" | "s" | "strike" => self.push_inline("~~"),
            "code" if self.pre_depth == 0 => {
                self.code_depth += 1;
                self.push_inline("`");
            }
            "code" => {
                if self.pre_language.is_none() {
                    self.pre_language = attribute(raw, "class").and_then(|class| {
                        class
                            .split_whitespace()
                            .find_map(|part| part.strip_prefix("language-").map(str::to_owned))
                    });
                }
            }
            "a" => {
                let href = attribute(raw, "href").and_then(|href| self.resolve(&href));
                if href.is_some() {
                    self.push_inline("[");
                }
                self.links.push(href);
            }
            "img" => {
                if let Some(src) = attribute(raw, "src").and_then(|src| self.resolve(&src)) {
                    let alt = attribute(raw, "alt").unwrap_or_default();
                    self.push_inline(&format!("![{}]({src})", escape_inline(alt.trim())));
                }
            }
            "ul" => {
                self.flush();
                self.lists.push(None);
            }
            "ol" => {
                self.flush();
                let start = attribute(raw, "start")
                    .and_then(|value| value.trim().parse::<u32>().ok())
                    .unwrap_or(1);
                self.lists.push(Some(start));
            }
            "li" => {
                self.flush();
                let marker = match self.lists.last_mut() {
                    Some(Some(counter)) => {
                        let marker = format!("{counter}. ");
                        *counter += 1;
                        marker
                    }
                    _ => "- ".to_owned(),
                };
                self.line.push_str(&marker);
            }
            "blockquote" => {
                self.flush();
                self.quote_depth += 1;
            }
            "pre" => {
                self.flush();
                self.pre_depth += 1;
                self.pre_buffer.clear();
                self.pre_language = None;
            }
            "table" => {
                self.flush();
                self.table = Some(Vec::new());
            }
            "tr" => {
                if let Some(table) = self.table.as_mut() {
                    table.push(Vec::new());
                }
            }
            "td" | "th" => {
                self.close_cell();
                if self.table.is_some() {
                    self.cell = Some(String::new());
                }
            }
            _ if BLOCKS.contains(&name) => self.flush(),
            _ => {}
        }
    }

    fn close_cell(&mut self) {
        if let Some(cell) = self.cell.take() {
            let text = cell.split_whitespace().collect::<Vec<_>>().join(" ");
            if let Some(row) = self.table.as_mut().and_then(|table| table.last_mut()) {
                row.push(text.replace('|', "\\|"));
            }
        }
    }

    fn close(&mut self, name: &str) {
        match name {
            "h1" | "h2" | "h3" | "h4" | "h5" | "h6" => {
                let heading = self.line.split_whitespace().collect::<Vec<_>>().join(" ");
                self.line.clear();
                if heading.trim_start_matches('#').trim().is_empty() {
                    return;
                }
                self.emit(&heading, false);
            }
            "strong" | "b" => self.push_inline("**"),
            "em" | "i" => self.push_inline("*"),
            "del" | "s" | "strike" => self.push_inline("~~"),
            "code" if self.pre_depth == 0 => {
                self.code_depth = self.code_depth.saturating_sub(1);
                self.push_inline("`");
            }
            "a" => {
                if let Some(Some(href)) = self.links.pop() {
                    self.push_inline(&format!("]({href})"));
                }
            }
            "ul" | "ol" => {
                self.flush();
                self.lists.pop();
                if self.lists.is_empty() {
                    // The next list is a new block, not a continuation.
                    self.last_was_list_item = false;
                }
            }
            "li" => self.flush(),
            "blockquote" => {
                self.flush();
                self.quote_depth = self.quote_depth.saturating_sub(1);
            }
            "pre" => {
                if self.pre_depth == 0 {
                    return;
                }
                self.pre_depth -= 1;
                if self.pre_depth == 0 {
                    let code = self.pre_buffer.trim_matches('\n').to_owned();
                    let fence = if code.contains("```") { "~~~~" } else { "```" };
                    let language = self.pre_language.take().unwrap_or_default();
                    self.emit(&format!("{fence}{language}\n{code}\n{fence}"), false);
                    self.pre_buffer.clear();
                }
            }
            "td" | "th" => self.close_cell(),
            "table" => {
                self.close_cell();
                if let Some(rows) = self.table.take() {
                    self.emit_table(rows);
                }
            }
            _ if BLOCKS.contains(&name) => self.flush(),
            _ => {}
        }
    }

    fn emit_table(&mut self, rows: Vec<Vec<String>>) {
        let rows: Vec<Vec<String>> = rows.into_iter().filter(|row| !row.is_empty()).collect();
        let width = rows.iter().map(Vec::len).max().unwrap_or(0);
        if width == 0 {
            return;
        }
        let line = |cells: &[String]| {
            let mut padded = cells.to_vec();
            padded.resize(width, String::new());
            format!("| {} |", padded.join(" | "))
        };
        let mut lines = vec![line(&rows[0]), line(&vec!["---".to_owned(); width])];
        lines.extend(rows[1..].iter().map(|row| line(row)));
        self.emit(&lines.join("\n"), false);
    }

    fn text(&mut self, raw: &str) {
        if self.drop_depth > 0 {
            return;
        }
        let decoded = decode_entities(raw);
        if self.pre_depth > 0 {
            self.pre_buffer.push_str(&decoded);
        } else {
            let collapsed = decoded.replace(['\n', '\r', '\t'], " ");
            if self.code_depth > 0 {
                self.push_inline(&collapsed);
            } else {
                self.push_inline(&escape_inline(&collapsed));
            }
        }
    }
}

/// Convert HTML to Markdown, resolving relative links against `base_url`.
pub(super) fn html_to_markdown(html: &str, base_url: Option<&str>) -> String {
    let mut converter = Converter {
        base_url: base_url.and_then(|base| url::Url::parse(base).ok()),
        ..Converter::default()
    };
    let mut rest = html;
    while let Some(open) = rest.find('<') {
        converter.text(&rest[..open]);
        let after = &rest[open..];
        if let Some(comment) = after.strip_prefix("<!--") {
            rest = comment.find("-->").map_or("", |end| &comment[end + 3..]);
            continue;
        }
        let Some(close) = after.find('>') else {
            converter.text(after);
            rest = "";
            break;
        };
        let raw = &after[1..close];
        rest = &after[close + 1..];
        if raw.starts_with('!') || raw.starts_with('?') {
            continue;
        }
        let closing = raw.starts_with('/');
        let name: String = raw
            .trim_start_matches('/')
            .chars()
            .take_while(|ch| ch.is_ascii_alphanumeric() || *ch == '-' || *ch == ':')
            .collect::<String>()
            .to_ascii_lowercase();
        if name.is_empty() {
            converter.text("<");
            rest = &after[1..];
            continue;
        }
        if DROPPED.contains(&name.as_str()) {
            if closing {
                if converter.dropped_stack.last() == Some(&name) {
                    converter.dropped_stack.pop();
                    converter.drop_depth -= 1;
                }
            } else if !raw.ends_with('/') {
                // Raw-text elements: skip straight to their end tag.
                if matches!(name.as_str(), "script" | "style" | "textarea") {
                    let needle = format!("</{name}");
                    let lower = rest.to_ascii_lowercase();
                    rest = match lower.find(&needle) {
                        Some(end) => rest[end..].find('>').map_or("", |gt| &rest[end + gt + 1..]),
                        None => "",
                    };
                } else {
                    converter.dropped_stack.push(name);
                    converter.drop_depth += 1;
                }
            }
            continue;
        }
        if converter.drop_depth > 0 {
            continue;
        }
        if closing {
            converter.close(&name);
        } else {
            converter.open(&name, raw);
            if VOID.contains(&name.as_str()) || raw.ends_with('/') {
                continue;
            }
        }
    }
    converter.text(rest);
    converter.close_cell();
    if let Some(rows) = converter.table.take() {
        converter.emit_table(rows);
    }
    converter.flush();
    converter.out.trim().to_owned()
}

/// The text of the first `<title>` element, if any.
pub(super) fn html_title(html: &str) -> Option<String> {
    let lower = html.to_ascii_lowercase();
    let start = lower.find("<title")?;
    let open_end = start + lower[start..].find('>')? + 1;
    let end = open_end + lower[open_end..].find("</title")?;
    let title = decode_entities(&html[open_end..end])
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ");
    (!title.is_empty()).then_some(title)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn converts_structure_links_and_drops_chrome() {
        let html = r#"<html><head><title>T</title><style>p{}</style></head><body>
            <nav><a href="/">Home</a></nav>
            <h1>Guide &amp; notes</h1>
            <p>Read <strong>this</strong> and <a href="/next">continue</a>.<br>Next line</p>
            <script>alert(1)</script>
            <ul><li>One<ul><li>Nested</li></ul></li><li>Two</li></ul>
            <ol start="3"><li>Three</li><li>Four</li></ol>
            <pre><code class="language-rust">fn main() {
    let x = 1 < 2;
}</code></pre>
            <blockquote><p>Quoted</p></blockquote>
            <table><tr><th>Name</th><th>Qty</th></tr><tr><td>A|B</td><td>2</td></tr></table>
            <p>Inline <code>x_y</code> and <a href="javascript:evil()">bad</a></p>
            <footer>(c) Acme</footer></body></html>"#;
        let markdown = html_to_markdown(html, Some("https://example.com/docs/"));
        assert_eq!(
            markdown,
            "# Guide & notes\n\n\
             Read **this** and [continue](https://example.com/next).\nNext line\n\n\
             - One\n  - Nested\n- Two\n\n\
             3. Three\n4. Four\n\n\
             ```rust\nfn main() {\n    let x = 1 < 2;\n}\n```\n\n\
             > Quoted\n\n\
             | Name | Qty |\n| --- | --- |\n| A\\|B | 2 |\n\n\
             Inline `x_y` and bad"
        );
    }

    #[test]
    fn reads_the_title_and_decodes_numeric_entities() {
        assert_eq!(
            html_title("<HTML><Title> A &#38; B &#x2014; C </title>").as_deref(),
            Some("A & B \u{2014} C")
        );
        assert_eq!(html_title("<p>none</p>"), None);
    }

    #[test]
    fn unclosed_markup_does_not_panic_or_loop() {
        assert_eq!(html_to_markdown("<p>a < b", None), "a < b");
        assert_eq!(html_to_markdown("<script>never closed", None), "");
        assert_eq!(html_to_markdown("<!-- open", None), "");
    }
}
