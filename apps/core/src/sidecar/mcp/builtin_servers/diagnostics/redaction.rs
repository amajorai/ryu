//! Secret and personal-data redaction for the `diagnostics.*` tools.
//!
//! A tool result goes to the model provider in use, so nothing leaves the
//! diagnostics module without passing through here: free text through
//! [`clean`] (redact, then cut) and every finished result through
//! [`redact_value`] once more.
//!
//! The rules follow the troubleshooter's browser-safe redaction
//! (`packages/core-client/src/troubleshoot-redaction.ts`) and begin with
//! [`crate::log_rotation::redact_log_text`], which owns Ryu's own token shapes.
//! They cover credentials in headers (`Authorization`, `Cookie`), provider and
//! Ryu token shapes, `Bearer` and `Basic` credentials, JWTs, private keys, URL
//! user info and secret query parameters, `name=value` pairs whose name says
//! the value is a secret, command-line secret flags, email addresses, home
//! folders, public IPv4 addresses and long opaque blobs.
//!
//! Order matters: text is redacted first and cut second. Cutting first could
//! leave half a token that no longer has the shape a rule looks for.
//!
//! What shape rules cannot do is recognise a secret with no telling shape and
//! no telling name. The diagnostics tools therefore never read a credential
//! store, a vault value, a request header or a command line in the first
//! place; this module is the second layer, not the only one.

use std::sync::OnceLock;

use regex::{Captures, Regex};
use serde_json::{Map, Value};

/// What replaces a secret whose kind is not worth naming.
pub(super) const REDACTED: &str = "[REDACTED]";

/// Names whose value is a credential, in `name=value`, `name: value` and
/// `"name": "value"` text. Also matched behind a prefix (`OPENAI_API_KEY`,
/// `x-ryu-node-token`). Plurals and counters (`max_tokens`) do not match.
const SECRET_NAMES: &str = r"api[_\-]?key|access[_\-]?key|secret[_\-]?key|private[_\-]?key|access[_\-]?token|refresh[_\-]?token|id[_\-]?token|auth[_\-]?token|session[_\-]?token|client[_\-]?secret|vault[_\-]?value|self[_\-]?call[_\-]?proof|secret|token|password|passwd|passphrase|authorization";

const PRIVATE_KEY: &str =
    r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*?-----END [A-Z ]*PRIVATE KEY-----";
/// A private key block cut off before its end marker.
const PRIVATE_KEY_OPEN: &str = r"(?s)-----BEGIN [A-Z ]*PRIVATE KEY-----.*";
/// `Cookie` and `Set-Cookie` - the value holds `;` and spaces, so the rest of
/// the line goes.
const COOKIE_HEADER: &str = r#"(?i)\b((?:set-)?cookie)\b(?:\\?["'])?[ \t]*[:=][^\r\n]*"#;
/// `Authorization` with any scheme word (`Bearer`, `Basic`, `Token`, `Digest`).
const AUTH_HEADER: &str = r#"(?i)\b((?:proxy-)?authorization)\b(?:\\?["'])?[ \t]*[:=][ \t]*(?:\\?["'])?(?:[A-Za-z]+[ \t]+)?[^\s"',;}\\]+"#;
const SCHEME_CREDENTIAL: &str = r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=\-]{8,}";
const PROVIDER_TOKEN: &str = r"\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_\-]{16,}|xox[abposr]-[A-Za-z0-9\-]{10,}|(?:AKIA|ASIA)[A-Z0-9]{16}|AIza[0-9A-Za-z_\-]{35}|hf_[A-Za-z0-9]{20,}|glpat-[A-Za-z0-9_\-]{20,}|npm_[A-Za-z0-9]{30,})";
/// `scheme://user:password@host` and `scheme://token@host`.
const URL_USERINFO: &str = r"\b([A-Za-z][A-Za-z0-9+.\-]*://)[^\s/@]+@";
const QUERY_SECRET: &str = r#"(?i)([?&](?:token|key|api_key|apikey|access_token|refresh_token|id_token|secret|client_secret|sig|signature|code|password|auth)=)[^&\s#"']+"#;
/// A secret name followed by a double-quoted value, which may hold spaces.
const SECRET_DOUBLE_QUOTED: &str = r#"(?i)(\b(?:[A-Za-z0-9]+[_\-])*(?:<NAMES>)\b(?:\\?["'])?[ \t]*[:=][ \t]*)\\?"(?:[^"\\\r\n]|\\.)*"?"#;
const SECRET_SINGLE_QUOTED: &str = r#"(?i)(\b(?:[A-Za-z0-9]+[_\-])*(?:<NAMES>)\b(?:\\?["'])?[ \t]*[:=][ \t]*)\\?'(?:[^'\\\r\n]|\\.)*'?"#;
const SECRET_BARE: &str =
    r#"(?i)(\b(?:[A-Za-z0-9]+[_\-])*(?:<NAMES>)\b(?:\\?["'])?[ \t]*[:=][ \t]*)[^\s"',;}&\\]+"#;
/// `--password hunter2`, `--api-key=abc`, `-token "a b"`.
const CLI_FLAG_SECRET: &str = r#"(?i)(^|[\s"'(\[=])(--?(?:[a-z0-9]+-)*(?:password|passwd|passphrase|token|secret|api-?key|access-?key|private-?key))(?:[ \t]+|=)(?:"[^"\r\n]*"?|'[^'\r\n]*'?|[^\s"']+)"#;
/// A credential at the very end of text that an earlier cut left too short for
/// the rules above.
const TAIL_SCHEME: &str = r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=\-]+(?:…|\.\.\.)?\s*$";
const TAIL_PROVIDER: &str =
    r"\b(?:github_pat_|gh[pousr]_|sk-|xox[abposr]-|hf_|glpat-)[A-Za-z0-9_\-]{4,}(?:…|\.\.\.)?\s*$";
const EMAIL: &str = r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}";
const WINDOWS_HOME: &str = r#"(?i)\b[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s"'`]+"#;
const UNIX_HOME: &str = r#"/(?:Users|home)/[^/\s"'`]+"#;
const IPV4: &str = r"\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b";
const HEX_BLOB: &str = r"\b[0-9A-Fa-f]{32,}\b";
/// A long run of token characters. Redacted only when it mixes upper case,
/// lower case and digits, so long plain identifiers stay readable.
const OPAQUE_BLOB: &str = r"[A-Za-z0-9_\-]{40,}|[A-Za-z0-9+/]{40,}={0,2}";

struct Rules {
    private_key: Regex,
    private_key_open: Regex,
    cookie_header: Regex,
    auth_header: Regex,
    scheme_credential: Regex,
    provider_token: Regex,
    url_userinfo: Regex,
    query_secret: Regex,
    secret_double_quoted: Regex,
    secret_single_quoted: Regex,
    secret_bare: Regex,
    cli_flag_secret: Regex,
    tail_scheme: Regex,
    tail_provider: Regex,
    email: Regex,
    windows_home: Regex,
    unix_home: Regex,
    ipv4: Regex,
    hex_blob: Regex,
    opaque_blob: Regex,
}

fn compile(pattern: &str) -> Regex {
    let pattern = pattern.replace("<NAMES>", SECRET_NAMES);
    Regex::new(&pattern).unwrap_or_else(|error| panic!("redaction pattern: {error}"))
}

fn rules() -> &'static Rules {
    static RULES: OnceLock<Rules> = OnceLock::new();
    RULES.get_or_init(|| Rules {
        private_key: compile(PRIVATE_KEY),
        private_key_open: compile(PRIVATE_KEY_OPEN),
        cookie_header: compile(COOKIE_HEADER),
        auth_header: compile(AUTH_HEADER),
        scheme_credential: compile(SCHEME_CREDENTIAL),
        provider_token: compile(PROVIDER_TOKEN),
        url_userinfo: compile(URL_USERINFO),
        query_secret: compile(QUERY_SECRET),
        secret_double_quoted: compile(SECRET_DOUBLE_QUOTED),
        secret_single_quoted: compile(SECRET_SINGLE_QUOTED),
        secret_bare: compile(SECRET_BARE),
        cli_flag_secret: compile(CLI_FLAG_SECRET),
        tail_scheme: compile(TAIL_SCHEME),
        tail_provider: compile(TAIL_PROVIDER),
        email: compile(EMAIL),
        windows_home: compile(WINDOWS_HOME),
        unix_home: compile(UNIX_HOME),
        ipv4: compile(IPV4),
        hex_blob: compile(HEX_BLOB),
        opaque_blob: compile(OPAQUE_BLOB),
    })
}

fn apply(rule: &Regex, text: String, replacement: &str) -> String {
    if !rule.is_match(&text) {
        return text;
    }
    rule.replace_all(&text, replacement).into_owned()
}

/// Loopback, private, link-local and unspecified addresses carry no identity
/// and are often the whole point of a diagnostic (`127.0.0.1:7980`).
fn is_non_identifying_ipv4(octets: &[u32]) -> bool {
    let first = octets.first().copied().unwrap_or(0);
    let second = octets.get(1).copied().unwrap_or(0);
    first == 0
        || first == 10
        || first == 127
        || (first == 169 && second == 254)
        || (first == 172 && (16..=31).contains(&second))
        || (first == 192 && second == 168)
}

fn redact_public_ipv4(rule: &Regex, text: String) -> String {
    if !rule.is_match(&text) {
        return text;
    }
    rule.replace_all(&text, |found: &Captures<'_>| {
        let octets: Vec<u32> = (1..=4)
            .filter_map(|index| found.get(index)?.as_str().parse().ok())
            .collect();
        if octets.len() != 4
            || octets.iter().any(|octet| *octet > 255)
            || is_non_identifying_ipv4(&octets)
        {
            found[0].to_owned()
        } else {
            "[REDACTED IP]".to_owned()
        }
    })
    .into_owned()
}

fn redact_opaque_blobs(rule: &Regex, text: String) -> String {
    if !rule.is_match(&text) {
        return text;
    }
    rule.replace_all(&text, |found: &Captures<'_>| {
        let run = &found[0];
        let mixed = run.chars().any(|c| c.is_ascii_uppercase())
            && run.chars().any(|c| c.is_ascii_lowercase())
            && run.chars().any(|c| c.is_ascii_digit());
        if mixed {
            "[REDACTED BLOB]".to_owned()
        } else {
            run.to_owned()
        }
    })
    .into_owned()
}

/// Characters that render as nothing and would let a value slip past a rule.
fn is_invisible(character: char) -> bool {
    matches!(
        character,
        '\u{00AD}' | '\u{200B}'..='\u{200D}' | '\u{2060}' | '\u{FEFF}'
    )
}

/// The ways one folder path can be written in a log line or a JSON string.
fn path_spellings(path: &str) -> Vec<String> {
    let mut spellings = vec![path.to_owned()];
    if path.contains('\\') {
        spellings.push(path.replace('\\', "\\\\"));
        spellings.push(path.replace('\\', "/"));
    }
    spellings
}

/// This process's own home folders, which the generic rules miss when a home
/// lives outside `/Users`, `/home` or `C:\Users`.
fn process_homes() -> &'static [String] {
    static HOMES: OnceLock<Vec<String>> = OnceLock::new();
    HOMES.get_or_init(|| {
        let mut homes: Vec<String> = ["HOME", "USERPROFILE"]
            .iter()
            .filter_map(|name| std::env::var(name).ok())
            .chain(dirs::home_dir().map(|home| home.to_string_lossy().into_owned()))
            .map(|home| home.trim().trim_end_matches(['/', '\\']).to_owned())
            .filter(|home| home.chars().count() > 3)
            .collect();
        homes.sort();
        homes.dedup();
        homes
    })
}

/// Strip credentials, email addresses, home folders, public IP addresses and
/// opaque blobs from free text. Idempotent: redacting the result again changes
/// nothing.
pub(super) fn redact_text(text: &str) -> String {
    redact_text_with_homes(text, process_homes())
}

/// [`redact_text`] with the home folders passed in, so a test can pin them.
pub(super) fn redact_text_with_homes(text: &str, homes: &[String]) -> String {
    let rules = rules();
    let mut out: String = if text.chars().any(is_invisible) {
        text.chars().filter(|c| !is_invisible(*c)).collect()
    } else {
        text.to_owned()
    };
    for home in homes {
        for spelling in path_spellings(home) {
            if out.contains(&spelling) {
                out = out.replace(&spelling, "~");
            }
        }
    }
    out = apply(&rules.private_key, out, "[REDACTED PRIVATE KEY]");
    out = apply(&rules.private_key_open, out, "[REDACTED PRIVATE KEY]");
    out = apply(&rules.cookie_header, out, "${1}: [REDACTED]");
    out = apply(&rules.auth_header, out, "${1}: [REDACTED]");
    out = crate::log_rotation::redact_log_text(&out).into_owned();
    out = apply(&rules.scheme_credential, out, "${1} [REDACTED]");
    out = apply(&rules.provider_token, out, "[REDACTED KEY]");
    out = apply(&rules.url_userinfo, out, "${1}[REDACTED]@");
    out = apply(&rules.query_secret, out, "${1}[REDACTED]");
    out = apply(&rules.secret_double_quoted, out, "${1}\"[REDACTED]\"");
    out = apply(&rules.secret_single_quoted, out, "${1}'[REDACTED]'");
    out = apply(&rules.secret_bare, out, "${1}[REDACTED]");
    out = apply(&rules.cli_flag_secret, out, "${1}${2} [REDACTED]");
    out = apply(&rules.tail_scheme, out, "${1} [REDACTED]");
    out = apply(&rules.tail_provider, out, "[REDACTED KEY]");
    out = apply(&rules.email, out, "[REDACTED EMAIL]");
    out = apply(&rules.windows_home, out, "~");
    out = apply(&rules.unix_home, out, "~");
    out = redact_public_ipv4(&rules.ipv4, out);
    out = apply(&rules.hex_blob, out, "[REDACTED HEX]");
    redact_opaque_blobs(&rules.opaque_blob, out)
}

/// Cut `text` to `max_chars` characters, marking the cut.
pub(super) fn clip(text: &str, max_chars: usize) -> String {
    let trimmed = text.trim();
    if trimmed.chars().count() <= max_chars {
        return trimmed.to_owned();
    }
    let mut out: String = trimmed.chars().take(max_chars).collect();
    out.push('…');
    out
}

/// Redact `text`, fold it onto one line, then cut it. Always in this order.
pub(super) fn clean(text: &str, max_chars: usize) -> String {
    let redacted = redact_text(text);
    let one_line = redacted.split_whitespace().collect::<Vec<_>>().join(" ");
    clip(&one_line, max_chars)
}

/// Whether a JSON field name says its value is a credential. Compared with
/// case, `_` and `-` removed, so `apiKey`, `api_key` and `API-KEY` are one name.
pub(super) fn is_secret_field(name: &str) -> bool {
    const EXACT: &[&str] = &[
        "auth",
        "jwt",
        "otp",
        "pin",
        "proof",
        "pwd",
        "sig",
        "signature",
    ];
    const ENDINGS: &[&str] = &[
        "authorization",
        "bearer",
        "cookie",
        "cookies",
        "credential",
        "credentials",
        "passphrase",
        "passwd",
        "password",
        "secret",
        "token",
    ];
    const PARTS: &[&str] = &["password", "secret", "selfcallproof", "vaultvalue"];
    let folded: String = name
        .chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect();
    EXACT.contains(&folded.as_str())
        || ENDINGS.iter().any(|ending| folded.ends_with(ending))
        || PARTS.iter().any(|part| folded.contains(part))
        || (folded.ends_with("key") && folded.len() > 3)
}

/// Redact a whole JSON value: every string and every field name through
/// [`redact_text`], and every value under a secret field name replaced outright
/// (booleans and nulls stay, since `"has_token": true` tells no secret).
pub(super) fn redact_value(value: &Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact_text(text)),
        Value::Array(items) => Value::Array(items.iter().map(redact_value).collect()),
        Value::Object(fields) => {
            let mut out = Map::with_capacity(fields.len());
            for (name, item) in fields {
                let keep_shape = matches!(item, Value::Null | Value::Bool(_));
                let cleaned = if is_secret_field(name) && !keep_shape {
                    Value::String(REDACTED.to_owned())
                } else {
                    redact_value(item)
                };
                out.insert(redact_text(name), cleaned);
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

#[cfg(test)]
#[path = "redaction_tests.rs"]
mod tests;
