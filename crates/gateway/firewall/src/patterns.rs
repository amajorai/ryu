//! Curated regex pattern builders for the firewall's detection sets (PII,
//! secrets, outbound secret egress, prompt injection, code injection, toxicity
//! and bias). The scan pre-pass [`crate::normalize_for_scan`] folds Unicode
//! obfuscation before these ASCII-oriented patterns run.

use regex::Regex;

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
        (
            "subprocess",
            r"(?i)\bsubprocess\s*\.\s*(?:call|run|popen|check_output)\s*\(",
        ),
        ("popen", r"(?i)\bpopen\s*\("),
        // Bare `system(` (C / PHP / Perl) — require a string-literal argument so
        // ordinary prose `operating system (Linux)` / `file system (ext4)` does not
        // Block. (Real `system("cmd")` / `system('cmd')` / `system(`cmd`)` matches.)
        ("system_call", r#"(?i)\bsystem\s*\(\s*["'\x60]"#),
        // Destructive shell: combined `-rf`/`-fr` (any order, with siblings),
        // split flags `rm -r -f`, and long form `--recursive --force`.
        (
            "rm_rf",
            r"(?i)\brm\s+(?:-\w+\s+)*-\w*r\w*f|(?i)\brm\s+(?:-\w+\s+)*-\w*f\w*r",
        ),
        ("rm_rf_split", r"(?i)\brm\s+-[rf]\b.{0,12}?-[rf]\b"),
        (
            "rm_rf_long",
            r"(?i)\brm\s+.{0,40}?--(?:recursive|force)\b.{0,40}?--(?:recursive|force)\b",
        ),
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
