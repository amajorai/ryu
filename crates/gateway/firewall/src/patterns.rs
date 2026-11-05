//! Curated regex pattern builders for the firewall's prompt injection, code
//! injection, toxicity and bias sets (the PII, secret and outbound secret
//! egress sets live in [`crate::leak_patterns`]). The scan pre-pass
//! [`crate::normalize_for_scan`] folds Unicode obfuscation before these
//! ASCII-oriented patterns run.

use regex::Regex;

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

pub(crate) fn compile_patterns(raw: &[(&str, &str)]) -> Vec<(String, Regex)> {
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
