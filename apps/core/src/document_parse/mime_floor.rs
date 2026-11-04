//! The document.parse facade: `CAP_DOCUMENT_PARSE` through `truncate_markdown`.
// test-exempt: moved verbatim out of document_parse.rs by the module split (no new
// behavior); its unit tests live in the `tests` module beside this file.

/// The capability this facade consumes. One string, one place.
pub const CAP_DOCUMENT_PARSE: &str = "document.parse";

/// Cap on bytes accepted for a parse, mirroring [`crate::server::uploads::MAX_UPLOAD_BYTES`]
/// so a file the user could attach is a file the parser will look at.
///
/// Reported to clients as `max_input_bytes` by [`parse_capability`], which is what
/// makes it the number the desktop's parsing panel prints instead of a client-side
/// constant. Equality with the upload ceiling is the *design* — a document only
/// reaches a parser by being uploaded first — not a coincidence to be hidden: the
/// panel renders the reported figure whether or not it happens to agree.
///
/// The in-process floor is bounded by [`MAX_BLOB_PARSE_BYTES`] instead, because a
/// blob address is not a request body.
pub const MAX_PARSE_BYTES: usize = crate::server::uploads::MAX_UPLOAD_BYTES;

/// Cap on bytes the typed in-process floor ([`builtin_parse`]) will read.
///
/// Deliberately NOT [`MAX_PARSE_BYTES`]: that one is an *HTTP upload* limit and means
/// nothing to a caller holding a blob address rather than a request body. A Space file
/// goes to 200 MiB, and a 50 MiB `.csv` must not be refused as "too large" on a path
/// where the same 50 MiB as a `.pdf` reaches a provider whose own ceiling is 200 MiB.
/// The read costs memory but the OUTPUT is clamped by [`MAX_MARKDOWN_BYTES`] either
/// way, so the wider bound buys correctness for free.
pub const MAX_BLOB_PARSE_BYTES: usize = 200 * 1024 * 1024;

/// Cap on extracted markdown returned to a caller, in bytes.
///
/// This bound exists because the extracted text lands in a chat turn and is
/// persisted with it: an unbounded 900-page PDF would be re-sent on every
/// subsequent turn of that thread. Truncation is REPORTED (`truncated: true`), never
/// silent — the whole point of this change is that files stop disappearing quietly.
pub const MAX_MARKDOWN_BYTES: usize = 400_000;

/// How long a single hop to the provider sidecar may take. Submit and poll are both
/// short by construction (the parse itself happens on the provider's worker pool),
/// so this is a transport bound, not a parse bound.
pub(in crate::document_parse) const PROVIDER_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(30);

/// Budget for the never-wakes `/capability` probe. Short on purpose: an asleep
/// provider must cost the caller a refused loopback connection, not a stall — this
/// runs on a settings-panel mount and on every composer mount.
pub(in crate::document_parse) const CAPABILITY_PROBE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(2);

/// How long to WAIT for a lazy/idle-stopped provider sidecar to become healthy
/// before declining the submit. Matches the ext-proxy's own wake budget. Only the
/// wait: the start itself runs detached in the sidecar manager with its own long
/// provisioning budget ([`crate::sidecar::manager::WAKE_START_BUDGET`]), so a first
/// start's venv + `pip install` is never cancelled by this timeout.
pub(in crate::document_parse) const WAKE_TIMEOUT: std::time::Duration =
    std::time::Duration::from_secs(20);

/// Extensions Core decodes itself, with no provider bound — the floor.
///
/// Every entry is a UTF-8 text family whose bytes ARE the document. Deliberately
/// excludes anything needing a real parser (`.pdf`, `.docx`, `.pptx`, `.xlsx`,
/// `.epub`, images): guessing at those would produce mojibake presented as content,
/// which is worse than the honest "no parser for this" the caller gets instead.
pub const BUILTIN_EXTENSIONS: &[&str] = &[
    ".txt",
    ".text",
    ".md",
    ".markdown",
    ".mdx",
    ".rst",
    ".org",
    ".csv",
    ".tsv",
    ".json",
    ".jsonl",
    ".ndjson",
    ".yaml",
    ".yml",
    ".toml",
    ".xml",
    ".html",
    ".htm",
    ".log",
    ".ini",
    ".conf",
    ".env",
    ".sql",
    ".tex",
    ".srt",
    ".vtt",
];

/// The lowercase extension of `filename`, dot included (`"a/b/Report.PDF"` → `".pdf"`).
///
/// Takes the LAST dot only. A compound suffix like `.tar.gz` therefore reads as
/// `.gz`, which is correct here: the floor does not claim archives, and a provider
/// that does matches on its own list.
pub fn extension_of(filename: &str) -> String {
    let base = filename.rsplit(['/', '\\']).next().unwrap_or(filename);
    match base.rfind('.') {
        Some(i) if i + 1 < base.len() => base[i..].to_ascii_lowercase(),
        _ => String::new(),
    }
}

/// Percent-decode a header value. Invalid escapes are kept verbatim rather than
/// dropped — a mangled character in a filename is recoverable, a silently shortened
/// one is not.
///
/// Route-only: decodes `x-filename` for [`parse_document`]. The in-process API is
/// handed a title directly and needs no decode.
pub(in crate::document_parse) fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(byte) = u8::from_str_radix(&s[i + 1..i + 3], 16) {
                out.push(byte);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Whether Core itself can read `filename` with no provider bound.
///
/// Keys on the **extension**, which is the whole answer only when the caller holds a
/// filename. A caller holding a *title* wants [`mime_floor_name`] as its second
/// signal — see that function for why the split is two calls and not one.
pub fn is_builtin_readable(filename: &str) -> bool {
    let ext = extension_of(filename);
    !ext.is_empty() && BUILTIN_EXTENSIONS.contains(&ext.as_str())
}

/// MIME types that map onto a [`BUILTIN_EXTENSIONS`] entry, for a document whose
/// **name carries no extension at all**.
///
/// Every right-hand side is already on the floor: this table can only re-route a
/// document to a reader Core would have used anyway for the same content, never widen
/// the floor to a new family. `text/rtf`, `application/octet-stream` and the
/// `text/x-<language>` source types are deliberately absent — the first is markup the
/// floor would emit as control words, the second is "unknown" (and is exactly what
/// `POST /api/spaces/:id/files` defaults to when a client sends no mime), and the
/// third has no floor extension to map onto.
pub(in crate::document_parse) const MIME_FLOOR_EXTENSIONS: &[(&str, &str)] = &[
    ("text/plain", ".txt"),
    ("text/markdown", ".md"),
    ("text/x-markdown", ".md"),
    ("text/csv", ".csv"),
    ("text/tab-separated-values", ".tsv"),
    ("application/json", ".json"),
    ("text/json", ".json"),
    ("application/x-ndjson", ".jsonl"),
    ("application/jsonl", ".jsonl"),
    ("application/yaml", ".yaml"),
    ("text/yaml", ".yaml"),
    ("application/x-yaml", ".yaml"),
    ("text/x-yaml", ".yaml"),
    ("application/toml", ".toml"),
    ("text/x-toml", ".toml"),
    ("application/xml", ".xml"),
    ("text/xml", ".xml"),
    ("text/html", ".html"),
    ("application/xhtml+xml", ".html"),
];

/// The floor filename for a **title with no extension**, recovered from its declared
/// MIME type — or `None` when the title already carries an extension, or the mime
/// names no floor family.
///
/// # Why this exists
///
/// [`is_builtin_readable`] keys on the extension, and two of the three
/// [`crate::space_file_index::create_file_indexed`] callers pass a **title**, not a
/// filename: `POST /api/spaces/:id/files` takes `body.title` and the `artifact.create`
/// MCP tool takes a `title` argument. So a note called `notes` with `mime:
/// text/plain` answered `false`, went to the bound provider, and landed on
/// `skipped/no_provider` — telling the user to install a document parser for a file
/// Core can read in-process, in microseconds, with no install at all.
///
/// # Why it refuses a title that HAS an extension
///
/// This may only *widen* the floor, never redirect a binary into a text reader. A
/// mime is client-supplied and can disagree with the bytes; if the title already says
/// `.pptx`, that extension is the more specific signal and it is the one the floor
/// already refused. Honouring a `text/plain` claim over it would hand a zip container
/// to [`decode_text`] — the exact failure the floor's narrowness exists to prevent. A
/// title with no extension carries no such contradiction, so the mime is the only
/// signal there is.
///
/// **This rule is a filter on the NAME, and a name check can never be the whole
/// answer.** It stops `deck.pptx` + `text/plain`; it cannot stop `notes` +
/// `text/plain` carrying the same zip, because a title with no extension contradicts
/// nothing. That case reaches the decoder, which is why [`decode_text`] refuses bytes
/// that are not plausibly text instead of lossily converting them. The two guards are
/// a pair, and neither alone closes the hole: this one keeps a *declared* binary off
/// the floor, that one keeps *actual* binary bytes from being stored as prose.
///
/// The cost of that rule is a title like `v1.2 notes`, whose "extension" (`.2 notes`)
/// is not one — it stays on the provider path. Refusing to read a text file is a
/// recoverable miss; confidently misreading a binary is not.
pub fn mime_floor_name(title: &str, mime: &str) -> Option<String> {
    if !extension_of(title).is_empty() {
        return None;
    }
    // Strip any `; charset=…` parameter and normalize case — `Text/Plain; charset=utf-8`
    // is the same type as `text/plain` and a client may send either.
    let essence = mime
        .split(';')
        .next()
        .unwrap_or_default()
        .trim()
        .to_ascii_lowercase();
    let ext = MIME_FLOOR_EXTENSIONS
        .iter()
        .find(|(m, _)| *m == essence)
        .map(|(_, ext)| *ext)?;
    Some(format!("{title}{ext}"))
}

/// Decode floor bytes to markdown, or `None` when they are not valid UTF-8.
///
/// Strict, not lossy, on purpose: a `.txt` that is actually UTF-16 or a mislabelled
/// binary should surface as "cannot read this" rather than as a page of replacement
/// characters the model would then reason about as if it were content. This is the
/// **route** floor and its strictness is the shipped `415 not_text` contract; the
/// in-process floor ([`builtin_parse`]) is allowed a lossy last resort because it can
/// report it in `warnings`, which an HTTP status code cannot.
///
/// HTML is tag-stripped rather than passed through: `.html` is on the floor because
/// its bytes are text, but handing a model raw `<div class="…">` markup as "the
/// document" spends the context window on layout. Minimal on purpose — see
/// [`strip_html`].
///
/// Route-only: [`parse_document`] is its sole caller. The in-process floor is
/// [`builtin_parse`], which differs deliberately — see there.
pub fn builtin_markdown(filename: &str, bytes: &[u8]) -> Option<(String, bool)> {
    let text = std::str::from_utf8(bytes).ok()?;
    Some(truncate_markdown(&apply_html_strip(filename, text)))
}

/// Tag-strip when the extension says HTML, pass through otherwise.
pub(in crate::document_parse) fn apply_html_strip(filename: &str, text: &str) -> String {
    match extension_of(filename).as_str() {
        ".html" | ".htm" => strip_html(text),
        _ => text.to_owned(),
    }
}

/// The minimal HTML-to-text reduction the floor performs.
///
/// Deliberately NOT an HTML parser: it drops `<script>`/`<style>` bodies, removes
/// tags, resolves the five XML entities plus `&nbsp;`/`&#39;`, and collapses runs of
/// blank lines. A real DOM-aware conversion (tables, headings, lists) is exactly what
/// a `document.parse` provider is for — the floor's job is to stop plain files from
/// needing one, not to compete with it.
pub(in crate::document_parse) fn strip_html(html: &str) -> String {
    // Drop the two element bodies that are never document content. Case-insensitive
    // on the tag name; an unclosed one swallows the remainder, which is the safe
    // direction (script text is never prose).
    let mut rest = html.to_owned();
    for tag in ["script", "style"] {
        rest = drop_element(&rest, tag);
    }

    let mut out = String::with_capacity(rest.len());
    let mut in_tag = false;
    for ch in rest.chars() {
        match ch {
            '<' => in_tag = true,
            '>' if in_tag => {
                in_tag = false;
                // A removed tag is a word boundary: `a<br>b` must not become `ab`.
                out.push('\n');
            }
            _ if in_tag => {}
            _ => out.push(ch),
        }
    }

    let decoded = out
        .replace("&nbsp;", " ")
        .replace("&#39;", "'")
        .replace("&quot;", "\"")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        // `&amp;` last, so `&amp;lt;` stays the literal `&lt;` it encoded.
        .replace("&amp;", "&");

    let mut lines: Vec<&str> = Vec::new();
    for line in decoded.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() && lines.last().is_some_and(|l: &&str| l.is_empty()) {
            continue;
        }
        lines.push(trimmed);
    }
    lines.join("\n").trim().to_owned()
}

/// Remove every `<tag …>…</tag>` region from `src`, tag name matched case-insensitively.
pub(in crate::document_parse) fn drop_element(src: &str, tag: &str) -> String {
    let lower = src.to_ascii_lowercase();
    let open = format!("<{tag}");
    let close = format!("</{tag}");
    let mut out = String::with_capacity(src.len());
    let mut cursor = 0usize;
    while let Some(hit) = lower[cursor..].find(&open) {
        let start = cursor + hit;
        out.push_str(&src[cursor..start]);
        match lower[start..].find(&close) {
            Some(end) => {
                let after = start + end;
                cursor = src[after..]
                    .find('>')
                    .map_or(src.len(), |gt| after + gt + 1);
            }
            // Unclosed: everything after the open tag is script/style text.
            None => cursor = src.len(),
        }
    }
    out.push_str(&src[cursor.min(src.len())..]);
    out
}

/// Clamp markdown to [`MAX_MARKDOWN_BYTES`] on a char boundary. Returns the text and
/// whether it was cut.
pub(in crate::document_parse) fn truncate_markdown(text: &str) -> (String, bool) {
    if text.len() <= MAX_MARKDOWN_BYTES {
        return (text.to_owned(), false);
    }
    let mut end = MAX_MARKDOWN_BYTES;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    (text[..end].to_owned(), true)
}
