//! Ryu Gateway firewall **scanning core** — the pure regex detection engine.
//!
//! Extracted from `apps/gateway/src/firewall/mod.rs` (decomposition: gateway
//! stage scanner). This crate holds everything with **no dependency on the
//! gateway pipeline's shared `AppState`** or the config cascade: the curated
//! PII / secret / injection / code-injection / toxicity / bias pattern
//! builders, the Unicode-obfuscation normalization pre-pass, the Luhn /
//! credit-card / public-IPv4 post-match validators, and the `DetectionKind` /
//! `FirewallMatch` scan types. The command-injection scanner lives in
//! [`cmdscan`].
//!
//! The wiring that consumes this engine — `FirewallScanner` (which holds
//! `FirewallConfig`, dragging in the alert/inspector/evaluator config cascade),
//! the `FirewallBackend` trait impl, and the `FirewallRegistry` — stays in
//! `apps/gateway/src/firewall/`. This is the same "engine moves, wiring stays"
//! cut the extracted core crates use.

use regex::Regex;

pub mod cmdscan;

/// A pattern match found in text.
#[derive(Debug, Clone)]
pub struct FirewallMatch {
    pub kind: DetectionKind,
    pub pattern_name: String,
}

#[derive(Debug, Clone, PartialEq)]
pub enum DetectionKind {
    Pii,
    Secret,
    PromptInjection,
    /// Toxic / hateful / harassing language (lexical seed; the real judgment is
    /// the `toxicity` evaluator's LLM-judge path).
    Toxicity,
    /// Unfair bias / identity-attack markers (lexical seed; real judgment is the
    /// `bias_fairness` LLM-judge path).
    Bias,
    /// Code-injection payloads (eval/exec/system/subprocess/rm -rf/`<script>`/SQLi).
    CodeInjection,
    /// Explicit imagery — a label only; image judging is not regex-based and is
    /// not enforced this phase (see the multimodal hook).
    ExplicitImage,
    /// Sensitive/graphic imagery — a label only (see `ExplicitImage`).
    SensitiveImage,
}

impl DetectionKind {
    /// Stable snake_case label for audit/logging and the firewall-check surface.
    pub fn as_str(&self) -> &'static str {
        match self {
            DetectionKind::Pii => "pii",
            DetectionKind::Secret => "secret",
            DetectionKind::PromptInjection => "prompt_injection",
            DetectionKind::Toxicity => "toxicity",
            DetectionKind::Bias => "bias",
            DetectionKind::CodeInjection => "code_injection",
            DetectionKind::ExplicitImage => "explicit_image",
            DetectionKind::SensitiveImage => "sensitive_image",
        }
    }
}

pub fn build_pii_patterns() -> Vec<(String, Regex)> {
    let raw = [
        // Email addresses
        ("email", r"[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}"),
        // US phone numbers. At least one separator (or a parenthesized area code)
        // is required so a bare 10-digit run (unix timestamps, order IDs) is NOT
        // misflagged as a phone number (red-team FP). International/E.164 formats
        // are a documented US-scoped coverage gap, not covered here.
        (
            "phone_us",
            r"\b(?:\+?1[-.\s]?)?(?:\(\d{3}\)\s?|\d{3}[-.\s])\d{3}[-.\s]\d{4}\b",
        ),
        // US Social Security Numbers — dash OR space separated (both are common
        // presentations). Bare 9-digit contiguous is intentionally NOT matched
        // (high false-positive risk without a keyword anchor).
        ("ssn", r"\b\d{3}[-\s]\d{2}[-\s]\d{4}\b"),
        // Credit card CANDIDATE: 13–19 digits in optional space/dash-separated
        // groups (the near-universal printed form). Precision comes from the Luhn
        // + prefix + length validator in `is_credit_card_number` (applied in
        // find_match / sanitize), so the spaced form `4111 1111 1111 1111` is
        // caught while arbitrary long digit runs are not.
        ("credit_card", r"\b(?:\d[ -]?){12,18}\d\b"),
        // IPv4 addresses. `is_public_ipv4` post-filters out loopback / RFC1918 /
        // link-local / multicast / subnet-mask shapes so benign technical output
        // (e.g. `255.255.255.0`, `127.0.0.1`, `192.168.1.1`) is not flagged.
        (
            "ipv4",
            r"\b(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\b",
        ),
        // Passport numbers — keyword-anchored to the word "passport" so the
        // generic letter+digits shape stops false-positiving on order/SKU/invoice
        // codes (`AB1234567`), the red-team's biggest PII FP source.
        (
            "passport",
            r"(?i)\bpassport\b[\s:#-]*(?:(?:no|num|number)\.?[\s:#-]*)?[A-Z]{1,2}[0-9]{6,9}\b",
        ),
        // IBAN — 2 letters + 2 check digits + up to 30 alphanumerics, printed in
        // optional space-separated groups of 4 (the conventional form), so
        // `GB29 NWBK 6016 1331 9268 19` is caught, not just the contiguous form.
        (
            "iban",
            r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,3})?\b",
        ),
    ];

    compile_patterns(&raw)
}

pub fn build_secret_patterns() -> Vec<(String, Regex)> {
    let raw = [
        // OpenAI API key
        ("openai_key", r"sk-[A-Za-z0-9]{20,}"),
        // Anthropic API key
        ("anthropic_key", r"sk-ant-[A-Za-z0-9\-_]{20,}"),
        // AWS Access Key ID
        ("aws_access_key", r"AKIA[0-9A-Z]{16}"),
        // AWS Secret Access Key
        (
            "aws_secret_key",
            r#"(?i)aws.{0,20}secret.{0,20}['"][0-9a-zA-Z/+]{40}['"]"#,
        ),
        // GitHub personal access tokens (classic)
        ("github_token_classic", r"ghp_[A-Za-z0-9]{36}"),
        // GitHub fine-grained PAT
        ("github_token_fg", r"github_pat_[A-Za-z0-9_]{82}"),
        // Generic high-entropy bearer tokens
        ("bearer_token", r"(?i)bearer\s+[A-Za-z0-9\-._~+/]{40,}"),
        // Private keys (PEM)
        (
            "pem_private_key",
            r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----",
        ),
        // Generic API key assignment patterns
        (
            "generic_api_key",
            r#"(?i)(?:api_key|apikey|api-key)\s*[:=]\s*['"]?[A-Za-z0-9\-_]{20,}['"]?"#,
        ),
        // Database connection strings
        (
            "db_connection",
            r"(?i)(?:mongodb|postgres|postgresql|mysql|redis):\/\/[^\s]+:[^\s]+@",
        ),
    ];

    compile_patterns(&raw)
}

/// Compiled outbound secret-egress patterns with STABLE `&'static str` markers.
///
/// Distinct from `build_secret_patterns` (which returns owned `String` names and
/// feeds the config-gated inbound/outbound scan). These markers are the stable
/// redaction labels (`[REDACTED:gh_pat]`, …) surfaced to callers, so they must
/// stay `&'static str` and not route through `compile_patterns`.
pub fn build_outbound_patterns() -> Vec<(&'static str, Regex)> {
    // (marker, regex). Order matters: more specific token shapes first so a
    // GitHub PAT is not partially eaten by a generic param rule.
    let raw: [(&'static str, &str); 7] = [
        // GitHub PATs: ghp_ (classic), gho_/ghu_/ghs_/ghr_ (OAuth/user/server/refresh)
        ("gh_pat", r"\bgh[pousr]_[A-Za-z0-9]{20,255}\b"),
        // GitHub fine-grained PAT
        ("gh_pat", r"\bgithub_pat_[A-Za-z0-9_]{22,255}\b"),
        // OpenAI-style sk- keys (incl. sk-proj-, sk-ant-)
        ("openai_key", r"\bsk-[A-Za-z0-9_\-]{20,}\b"),
        // AWS access key id
        ("aws_akid", r"\bAKIA[0-9A-Z]{16}\b"),
        // Bearer <token>
        ("bearer", r"(?i)\bbearer\s+[A-Za-z0-9\-._~+/]{16,}=*"),
        // token= / api_key= / apikey= / access_token= query-or-form params
        (
            "token_param",
            r"(?i)\b(?:api[_-]?key|access[_-]?token|token)=[A-Za-z0-9\-._~+/]{8,}",
        ),
        // password= / secret= / passwd= query-or-form params
        (
            "secret_param",
            r#"(?i)\b(?:password|passwd|secret)=[^&\s"']{4,}"#,
        ),
    ];
    raw.iter()
        .filter_map(|(marker, pat)| match Regex::new(pat) {
            Ok(re) => Some((*marker, re)),
            Err(e) => {
                tracing::error!("Failed to compile outbound pattern '{marker}': {e}");
                None
            }
        })
        .collect()
}

pub fn build_injection_patterns() -> Vec<(String, Regex)> {
    let raw = [
        // Instruction-override: broad verb set (ignore/disregard/forget/override/
        // bypass) × broad noun set (instructions/rules/prompt/directives/guidelines/
        // context/commands), with up to 5 filler words between. Catches the common
        // phrasings the narrow `ignore <previous> instructions` seed missed:
        // "ignore all/the/your instructions", "disregard …", "override your rules".
        (
            "instruction_override",
            r"(?i)\b(?:ignore|disregard|forget|override|bypass)\b(?:\s+\w+){0,5}?\s+(?:instructions?|rules?|prompts?|directives?|guidelines?|context|commands?)\b",
        ),
        // "forget everything above" — `everything` is anchored to a DIRECTIONAL word
        // so benign "forget everything I said about the budget" does not trip.
        (
            "forget_context",
            r"(?i)\b(?:ignore|disregard|forget|erase|clear)\s+everything\s+(?:above|before|previously|prior|earlier)\b",
        ),
        // "You are now / you will act as"
        (
            "persona_override",
            r"(?i)you\s+(?:are\s+now|will\s+now\s+act\s+as|must\s+act\s+as)\s+(?:an?\s+)?(?:evil|uncensored|unfiltered|jailbreak|DAN)",
        ),
        // DAN / jailbreak markers. `DAN` is CASE-SENSITIVE (all-caps) so the common
        // first name "Dan" is not flagged; bare `jailbreak` requires an AI/model
        // context so "jailbreak my iPhone" is not flagged.
        (
            "dan_jailbreak",
            r"\bDAN\b|(?i:\bdo\s+anything\s+now\b)|(?i:\bjailbreak\b\s+(?:the\s+)?(?:ai|model|assistant|gpt|llm|chatbot|prompt|system|filter|guardrails?)\b)|(?i:\b(?:ai|model|assistant|gpt|llm|chatbot|prompt)\s+jailbreak\b)",
        ),
        // Prompt leaking attempts — require possessive/system framing ("your system
        // prompt", "the initial instructions") so ordinary tech prose ("output
        // instructions for the CPU", "display context") is not flagged.
        (
            "prompt_leak",
            r"(?i)\b(?:repeat|print|output|reveal|show|display|dump|leak|expose|give\s+me|tell\s+me)\b(?:\s+\w+){0,3}?\s+(?:your|the)\s+(?:(?:system|initial|hidden|original|internal)\s+)?(?:prompt|instructions?)\b",
        ),
        // Role-play to bypass
        (
            "roleplay_bypass",
            r"(?i)(?:pretend|imagine|roleplay|act)\s+(?:you\s+are|as\s+if)\s+(?:you\s+have\s+no|without\s+any)\s+(?:restrictions|limits|guidelines|rules|ethics)",
        ),
        // Token smuggling via unicode/encoding hints — BOTH orderings ("base64 decode
        // this" and the more natural "decode this base64 / decode the following from
        // hex"). The encoded BODY itself stays out of regex reach (judge territory).
        (
            "token_smuggling",
            r"(?i)(?:base64|hex|rot13|caesar)\s+(?:decode|encode|encrypt|decrypt)|(?i)(?:decode|decrypt|decompress)\s+(?:this\s+|the\s+following\s+|it\s+|the\s+)?(?:string\s+)?(?:from\s+)?(?:base64|hex|rot13|caesar)\b",
        ),
    ];

    compile_patterns(&raw)
}

/// Code-injection payload patterns for the `code_injection` evaluator (Input
/// target). Best-effort deterministic seed; catches the obvious dangerous-call
/// and shell shapes. Anchored loosely so `os.system("rm -rf /")` and friends trip.
pub fn build_code_injection_patterns() -> Vec<(String, Regex)> {
    let raw = [
        // eval( / exec( function-call forms (JS/Python). Require a NON-empty arg so
        // the benign discussion form `use eval() in Python` (empty parens) is not
        // Blocked; payloads always pass an argument. (`eval(x)` inside a sentence is
        // still an inherent regex-vs-intent FP — that is LLM-judge territory.)
        ("eval_call", r"(?i)\beval\s*\(\s*[^\s)]"),
        ("exec_call", r"(?i)\bexec\s*\(\s*[^\s)]"),
        // Python os.system / subprocess / popen. `\s*` around the dot so the spaced
        // `os . system(` / `os . popen(` evasion is covered too.
        ("os_system", r"(?i)\bos\s*\.\s*system\s*\("),
        ("subprocess", r"(?i)\bsubprocess\s*\.\s*(?:call|run|popen|check_output)\s*\("),
        ("popen", r"(?i)\bpopen\s*\("),
        // Bare `system(` (C / PHP / Perl) — require a string-literal argument so
        // ordinary prose `operating system (Linux)` / `file system (ext4)` does not
        // Block. (Real `system("cmd")` / `system('cmd')` / `system(`cmd`)` matches.)
        ("system_call", r#"(?i)\bsystem\s*\(\s*["'\x60]"#),
        // Destructive shell: combined `-rf`/`-fr` (any order, with siblings),
        // split flags `rm -r -f`, and long form `--recursive --force`.
        ("rm_rf", r"(?i)\brm\s+(?:-\w+\s+)*-\w*r\w*f|(?i)\brm\s+(?:-\w+\s+)*-\w*f\w*r"),
        ("rm_rf_split", r"(?i)\brm\s+-[rf]\b.{0,12}?-[rf]\b"),
        ("rm_rf_long", r"(?i)\brm\s+.{0,40}?--(?:recursive|force)\b.{0,40}?--(?:recursive|force)\b"),
        // Command substitution. Backticks and `$()` are narrowed to a shell-command
        // token inside, since users routinely paste ordinary `code` in backticks and
        // jQuery `$(selector)` is not injection (the raw span match was a massive
        // Block-on-Input FP source).
        (
            "backtick_subst",
            r"(?i)`[^`]*\b(?:rm|curl|wget|bash|sh|nc|ncat|chmod|chown|sudo|eval|exec|mkfifo|dd|mkfs|whoami|id|base64|powershell|scp)\b[^`]*`",
        ),
        (
            "dollar_paren_subst",
            r"(?i)\$\(\s*(?:rm|curl|wget|bash|sh|nc|ncat|chmod|chown|sudo|eval|exec|cat|mkfifo|dd|whoami|id|base64|python|perl|echo|printf|ls|which|env)\b",
        ),
        // HTML/script injection.
        ("script_tag", r"(?i)<\s*script\b"),
        // SQL-injection markers. `union select` must be ADJACENT (the actual SQLi
        // shape) so benign prose `European Union ... will select` does not match.
        ("sql_or_1_1", r"(?i)'\s*or\s+1\s*=\s*1"),
        ("sql_union_select", r"(?i)\bunion\s+(?:all\s+)?select\b"),
        ("sql_drop_table", r"(?i);\s*drop\s+table\b"),
    ];
    compile_patterns(&raw)
}

/// Lexical toxicity seed for the `toxicity` evaluator (Output target). Deliberately
/// small — the authoritative judgment is the LLM-judge path; this catches obvious
/// slurs/harassment deterministically so an enabled binding is never a pure no-op.
/// Word-boundary anchored to reduce false positives on substrings (e.g. "assess").
pub fn build_toxicity_patterns() -> Vec<(String, Regex)> {
    let raw = [
        (
            "profanity",
            r"(?i)\b(?:fuck|shit|bitch|bastard|asshole|dickhead|motherfucker)\b",
        ),
        (
            "harassment",
            r"(?i)\b(?:kill yourself|kys|go die|go kill yourself|piece of (?:shit|garbage|trash))\b",
        ),
        // NB: the ambiguous `retard`/`retarded` lexeme was intentionally DROPPED —
        // it false-positives on the legitimate verb/adjective ("cold temperatures
        // retard the reaction", "flame retardant") and on meta/educational
        // discussion that quotes the slur. Contextual slur judgment is LLM-judge
        // territory; the deterministic seed stays to unambiguous profanity/threats.
    ];
    compile_patterns(&raw)
}

/// Lexical bias / identity-attack seed for the `bias_fairness` evaluator (Output
/// target). Small deterministic seed; the LLM-judge path is authoritative. Flags
/// blanket generalizations attached to a protected-group term.
pub fn build_bias_patterns() -> Vec<(String, Regex)> {
    let raw = [
        (
            "group_generalization",
            r"(?i)\b(?:all|those|these)\s+(?:women|men|blacks|whites|asians|jews|muslims|christians|gays|immigrants)\s+are\b",
        ),
        (
            "inferiority_claim",
            r"(?i)\b(?:women|men|blacks|whites|asians|jews|muslims|immigrants)\s+are\s+(?:inferior|stupid|lazy|dangerous|criminals)\b",
        ),
    ];
    compile_patterns(&raw)
}

/// Normalize `text` for regex scanning so trivial Unicode obfuscation cannot
/// evade the ASCII-oriented pattern sets (red-team P3):
///
/// - strips zero-width / default-ignorable code points (U+200B–200D word/zero
///   joiners, U+FEFF BOM, U+2060 word-joiner, U+00AD soft hyphen, U+034F CGJ,
///   U+180E, variation selectors U+FE00–FE0F) that split `e\u{200b}val` /
///   `i\u{200c}gnore`,
/// - folds fullwidth ASCII (U+FF01–FF5E → U+0021–007E) and the ideographic space
///   (U+3000 → SP) so `ｉｇｎｏｒｅ`, fullwidth `＠`/`．`, and `　` collapse to ASCII,
/// - folds the common cross-script confusables (Cyrillic/Greek Latin-lookalikes)
///   so `еval` (Cyrillic е) / `kіll` fold to their ASCII intent.
///
/// This is deterministic and cheap; the fast path returns the input borrowed when
/// nothing needs folding (the overwhelmingly common all-ASCII case). It feeds the
/// detection scans (`FirewallScanner::find_match`) only — the redaction paths
/// (`sanitize`/`redact_*`) keep operating on the ORIGINAL text so match offsets
/// stay valid, so homoglyph PII is detected/audited but physical redaction of the
/// folded token is best-effort. Base64/hex-encoded payloads and leetspeak stay
/// out of scope for regex (LLM-judge territory).
pub fn normalize_for_scan(text: &str) -> std::borrow::Cow<'_, str> {
    // Fast path: pure ASCII with no default-ignorable chars ⇒ nothing to fold.
    if text.is_ascii() {
        return std::borrow::Cow::Borrowed(text);
    }
    let mut out = String::with_capacity(text.len());
    let mut changed = false;
    for c in text.chars() {
        if is_default_ignorable(c) {
            changed = true;
            continue;
        }
        let cp = c as u32;
        let folded = if (0xFF01..=0xFF5E).contains(&cp) {
            // Fullwidth ASCII → ASCII.
            char::from_u32(cp - 0xFEE0).unwrap_or(c)
        } else if cp == 0x3000 {
            ' ' // Ideographic space.
        } else {
            fold_confusable(c)
        };
        if folded != c {
            changed = true;
        }
        out.push(folded);
    }
    if changed {
        std::borrow::Cow::Owned(out)
    } else {
        std::borrow::Cow::Borrowed(text)
    }
}

/// Zero-width / default-ignorable code points that carry no visible glyph but
/// split regex-matched runs. Stripped before scanning.
fn is_default_ignorable(c: char) -> bool {
    matches!(c,
        '\u{200B}' | '\u{200C}' | '\u{200D}' | '\u{2060}' | '\u{FEFF}'
        | '\u{00AD}' | '\u{034F}' | '\u{180E}' | '\u{2061}'..='\u{2064}'
        | '\u{FE00}'..='\u{FE0F}')
}

/// Fold the common Latin-lookalike confusables (Cyrillic + Greek) to ASCII. NFKC
/// does NOT do this (different scripts are not compatibility-equivalent), so this
/// manual table is load-bearing for the homoglyph bypass class. Codepoints are the
/// exact ones the red-team payloads use, plus their obvious siblings.
fn fold_confusable(c: char) -> char {
    match c {
        // Cyrillic lowercase → Latin.
        '\u{0430}' => 'a', '\u{0435}' => 'e', '\u{043E}' => 'o', '\u{0440}' => 'p',
        '\u{0441}' => 'c', '\u{0443}' => 'y', '\u{0445}' => 'x', '\u{0456}' => 'i',
        '\u{0455}' => 's', '\u{0458}' => 'j', '\u{043A}' => 'k', '\u{0501}' => 'd',
        '\u{051B}' => 'q', '\u{051D}' => 'w', '\u{0432}' => 'v', '\u{04CF}' => 'l',
        // Cyrillic uppercase → Latin.
        '\u{0410}' => 'A', '\u{0412}' => 'B', '\u{0415}' => 'E', '\u{041A}' => 'K',
        '\u{041C}' => 'M', '\u{041D}' => 'H', '\u{041E}' => 'O', '\u{0420}' => 'P',
        '\u{0421}' => 'C', '\u{0422}' => 'T', '\u{0423}' => 'Y', '\u{0425}' => 'X',
        '\u{0406}' => 'I', '\u{0405}' => 'S', '\u{0408}' => 'J',
        // Greek lowercase → Latin.
        '\u{03BF}' => 'o', '\u{03B1}' => 'a', '\u{03C1}' => 'p', '\u{03BD}' => 'v',
        '\u{03B5}' => 'e', '\u{03B9}' => 'i', '\u{03BA}' => 'k', '\u{03C5}' => 'y',
        // Greek uppercase → Latin.
        '\u{0391}' => 'A', '\u{0392}' => 'B', '\u{0395}' => 'E', '\u{0397}' => 'H',
        '\u{0399}' => 'I', '\u{039A}' => 'K', '\u{039C}' => 'M', '\u{039D}' => 'N',
        '\u{039F}' => 'O', '\u{03A1}' => 'P', '\u{03A4}' => 'T', '\u{03A5}' => 'Y',
        '\u{03A7}' => 'X', '\u{0396}' => 'Z',
        _ => c,
    }
}

/// Luhn checksum validation for a digit string (credit-card mod-10). Reduces the
/// false-positive rate of the broadened (separator-tolerant) card candidate: an
/// arbitrary 13–19 digit run only trips the detector when it actually checksums.
fn luhn_valid(digits: &str) -> bool {
    let mut sum = 0u32;
    let mut alt = false;
    let mut count = 0u32;
    for ch in digits.chars().rev() {
        let Some(d) = ch.to_digit(10) else {
            return false;
        };
        count += 1;
        let mut d = d;
        if alt {
            d *= 2;
            if d > 9 {
                d -= 9;
            }
        }
        sum += d;
        alt = !alt;
    }
    count >= 12 && sum % 10 == 0
}

/// True when a `credit_card` candidate match (which may carry ` `/`-` group
/// separators) is a plausible card: 13–19 digits, a major-industry prefix (3/4/5/6),
/// and a valid Luhn checksum.
pub fn is_credit_card_number(matched: &str) -> bool {
    let digits: String = matched.chars().filter(|c| c.is_ascii_digit()).collect();
    let len = digits.len();
    if !(13..=19).contains(&len) {
        return false;
    }
    let first = digits.as_bytes()[0];
    if !matches!(first, b'3' | b'4' | b'5' | b'6') {
        return false;
    }
    luhn_valid(&digits)
}

/// True when an `ipv4` match is a public/routable address worth flagging as PII.
/// Excludes the benign-in-technical-output ranges the red-team flagged: loopback,
/// RFC1918 private, link-local, multicast/reserved, `0.0.0.0`, and the
/// all-ones/subnet-mask-shaped `255.x`. Keeps genuine public IPs (e.g. `8.8.8.8`).
pub fn is_public_ipv4(matched: &str) -> bool {
    let octets: Vec<u8> = matched.split('.').filter_map(|o| o.parse().ok()).collect();
    if octets.len() != 4 {
        return false;
    }
    let [a, b, ..] = octets[..] else {
        return false;
    };
    match a {
        0 | 10 | 127 => false,                 // this-network, RFC1918-10, loopback
        169 if b == 254 => false,              // link-local
        172 if (16..=31).contains(&b) => false, // RFC1918-172
        192 if b == 168 => false,              // RFC1918-192
        255 => false,                          // broadcast / subnet-mask shapes
        224..=255 => false,                    // multicast + reserved
        _ => true,
    }
}

fn compile_patterns(raw: &[(&str, &str)]) -> Vec<(String, Regex)> {
    raw.iter()
        .filter_map(|(name, pattern)| match Regex::new(pattern) {
            Ok(re) => Some(((*name).to_string(), re)),
            Err(e) => {
                tracing::error!("Failed to compile firewall pattern '{}': {}", name, e);
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Unicode normalization strips zero-width chars and folds fullwidth +
    /// Cyrillic/Greek confusables to ASCII (the shared pre-pass feeding find_match).
    #[test]
    fn normalize_folds_obfuscation() {
        // Zero-width non-joiner inside a word is stripped.
        assert_eq!(normalize_for_scan("i\u{200c}gnore").as_ref(), "ignore");
        // Fullwidth commercial-at / full-stop fold to ASCII.
        assert_eq!(
            normalize_for_scan("user\u{FF20}example\u{FF0E}com").as_ref(),
            "user@example.com"
        );
        // Cyrillic homoglyphs fold to Latin.
        assert_eq!(normalize_for_scan("\u{0435}val").as_ref(), "eval");
        // Ideographic space folds to a normal space.
        assert_eq!(normalize_for_scan("a\u{3000}b").as_ref(), "a b");
        // Pure ASCII is returned borrowed (fast path, unchanged).
        assert!(matches!(
            normalize_for_scan("plain ascii"),
            std::borrow::Cow::Borrowed(_)
        ));
    }

    /// Credit-card / IPv4 post-match validators (the precision filters applied
    /// after a candidate regex match in `FirewallScanner::find_match`).
    #[test]
    fn credit_card_and_ipv4_validators() {
        // Valid Visa test number (spaced) passes Luhn + prefix + length.
        assert!(is_credit_card_number("4111 1111 1111 1111"));
        // Arbitrary long digit run fails Luhn.
        assert!(!is_credit_card_number("1234 5678 9012 3456"));
        // Public IP is flagged; loopback / RFC1918 / subnet-mask shapes are not.
        assert!(is_public_ipv4("8.8.8.8"));
        assert!(!is_public_ipv4("127.0.0.1"));
        assert!(!is_public_ipv4("192.168.1.1"));
        assert!(!is_public_ipv4("255.255.255.0"));
    }
}
