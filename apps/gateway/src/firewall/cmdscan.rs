//! Command execution scanner: hardline blocklist (always deny) + ~40 risk
//! patterns evaluated under an approval mode.
//!
//! Pure and env-free: the [`ApprovalMode`] is a parameter, so every decision is
//! deterministic and unit-testable. The env var (`RYU_EXEC_APPROVAL_MODE`) is
//! parsed at the HTTP handler boundary only (see `tools::exec::exec_scan`).
//!
//! Two regex sets are compiled ONCE at call time from static tables (never in a
//! loop): a small HARDLINE set that always denies regardless of mode, and a
//! larger PATTERN set whose severities drive the manual/smart escalation. All
//! patterns are plain top-level regex literals.

use regex::Regex;
use serde::Serialize;

/// Approval posture for command execution. Sourced from
/// `RYU_EXEC_APPROVAL_MODE` at the handler boundary; passed here as a value so
/// the scanner stays pure.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ApprovalMode {
    /// Any risk-pattern hit requires human approval (default, safest).
    Manual,
    /// Cheap severity classifier: critical denies, high/medium escalate, low
    /// auto-allows.
    Smart,
    /// Risk patterns are ignored (hardline blocklist still always denies).
    Off,
}

impl ApprovalMode {
    /// Parse the `RYU_EXEC_APPROVAL_MODE` env value. Unknown / empty ⇒ `Manual`.
    pub fn from_env_str(s: &str) -> Self {
        match s.trim().to_ascii_lowercase().as_str() {
            "off" => Self::Off,
            "smart" => Self::Smart,
            _ => Self::Manual,
        }
    }
}

/// Risk severity of a single finding.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Severity {
    Low,
    Medium,
    High,
    Critical,
}

/// One matched risk pattern (or the hardline match) in a scanned command.
#[derive(Debug, Clone, Serialize)]
pub struct Finding {
    pub pattern: String,
    pub category: String,
    pub severity: Severity,
}

/// Final governance decision for a scanned command.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Decision {
    Allow,
    Deny,
    ApprovalRequired,
}

/// Verdict returned to Core. Serializes to exactly
/// `{ "decision": ..., "reason": ..., "findings": [...] }`.
#[derive(Debug, Clone, Serialize)]
pub struct ScanVerdict {
    pub decision: Decision,
    pub reason: Option<String>,
    pub findings: Vec<Finding>,
}

/// Scan a command for governance. Pure over `(backend, command, mode)`.
///
/// Decision order:
/// 1. HARDLINE set first — any match ⇒ `Deny` (always, regardless of mode or a
///    future YOLO bypass; honor a global YOLO bypass here if one is later added,
///    but hardline still denies).
/// 2. `Off` ⇒ `Allow` (no findings beyond hardline).
/// 3. Collect PATTERN matches. None ⇒ `Allow`.
/// 4. `Manual` with ≥1 finding ⇒ `ApprovalRequired`.
/// 5. `Smart`: max severity — `Critical` ⇒ `Deny`; `High`/`Medium` ⇒
///    `ApprovalRequired`; only `Low` ⇒ `Allow`.
pub fn scan_command(_backend: &str, command: &str, mode: ApprovalMode) -> ScanVerdict {
    // 1. Hardline blocklist — always denies.
    for (name, re) in build_hardline() {
        if re.is_match(command) {
            return ScanVerdict {
                decision: Decision::Deny,
                reason: Some(format!("hardline blocklist: {name}")),
                findings: vec![Finding {
                    pattern: name.to_string(),
                    category: "hardline".to_string(),
                    severity: Severity::Critical,
                }],
            };
        }
    }

    // 1b. Token-level hardline: an `rm` invocation whose flags COLLECTIVELY
    // request recursion AND force AND target filesystem root, in ANY
    // order/separation (`rm -r -f /`, `rm --recursive --force /`, `rm -R -f /`,
    // ...). The regex crate has no lookahead, so these cannot be expressed as a
    // single anchored pattern and must be evaluated on tokens. This runs BEFORE
    // the Off short-circuit so it denies in every mode, matching the contiguous
    // `rm_rf_root` and `no_preserve_root` regex hardlines above.
    if rm_root_recursive_force(command) {
        return ScanVerdict {
            decision: Decision::Deny,
            reason: Some("hardline blocklist: rm_root_recursive_force".to_string()),
            findings: vec![Finding {
                pattern: "rm_root_recursive_force".to_string(),
                category: "hardline".to_string(),
                severity: Severity::Critical,
            }],
        };
    }

    // 2. Off mode: nothing beyond hardline is enforced.
    if mode == ApprovalMode::Off {
        return ScanVerdict {
            decision: Decision::Allow,
            reason: None,
            findings: Vec::new(),
        };
    }

    // 3. Collect all risk-pattern matches.
    let mut findings: Vec<Finding> = Vec::new();
    for (name, category, severity, re) in build_patterns() {
        if re.is_match(command) {
            findings.push(Finding {
                pattern: name.to_string(),
                category: category.to_string(),
                severity,
            });
        }
    }
    if findings.is_empty() {
        return ScanVerdict {
            decision: Decision::Allow,
            reason: None,
            findings,
        };
    }

    // 4/5. Escalate per mode.
    match mode {
        ApprovalMode::Off => unreachable!("Off handled above"),
        ApprovalMode::Manual => ScanVerdict {
            decision: Decision::ApprovalRequired,
            reason: Some("risk patterns require manual approval".to_string()),
            findings,
        },
        ApprovalMode::Smart => {
            let max = findings
                .iter()
                .map(|f| f.severity)
                .max_by_key(|s| severity_rank(*s))
                .unwrap_or(Severity::Low);
            let (decision, reason) = match max {
                Severity::Critical => (
                    Decision::Deny,
                    Some("critical-severity command denied".to_string()),
                ),
                Severity::High | Severity::Medium => (
                    Decision::ApprovalRequired,
                    Some("elevated-risk command requires approval".to_string()),
                ),
                Severity::Low => (Decision::Allow, None),
            };
            ScanVerdict {
                decision,
                reason,
                findings,
            }
        }
    }
}

fn severity_rank(s: Severity) -> u8 {
    match s {
        Severity::Low => 0,
        Severity::Medium => 1,
        Severity::High => 2,
        Severity::Critical => 3,
    }
}

/// Compile a `(name, pattern)` table into `(name, Regex)`, dropping (and
/// logging) any entry that fails to compile. Never called in a hot loop.
fn compile_named(raw: &[(&'static str, &str)]) -> Vec<(&'static str, Regex)> {
    raw.iter()
        .filter_map(|(name, pat)| match Regex::new(pat) {
            Ok(re) => Some((*name, re)),
            Err(e) => {
                tracing::error!("Failed to compile cmdscan hardline '{name}': {e}");
                None
            }
        })
        .collect()
}

/// Token-level hardline check for a root-targeting recursive-force `rm`.
///
/// Returns true when some command segment contains an `rm` invocation whose
/// flag tokens COLLECTIVELY include (a) a recursive flag (`-r`, `-R`,
/// `--recursive`, or a bundled short flag containing r/R such as `-rf`/`-Rf`),
/// AND (b) a force flag (`-f`, `--force`, or a bundled short flag containing f),
/// AND (c) a bare root target (a standalone `/` argument, or the presence of
/// `--no-preserve-root`) - in any order or separation.
///
/// The command is split into segments on shell operator characters (`;`, `|`,
/// `&`, newline) so an `rm` inside a pipeline or command list is analyzed
/// against only its own flags and arguments. Compiled-regex-free and allocation
/// -light; called once per scan, never in a hot loop.
fn rm_root_recursive_force(command: &str) -> bool {
    for segment in command.split(|c| matches!(c, ';' | '|' | '&' | '\n')) {
        let mut saw_rm = false;
        let mut recursive = false;
        let mut force = false;
        let mut root_target = false;
        for tok in segment.split_whitespace() {
            if !saw_rm {
                // Skip any leading prefix (sudo, env assignments) until `rm`.
                if tok == "rm" {
                    saw_rm = true;
                }
                continue;
            }
            match tok {
                "--no-preserve-root" => root_target = true,
                "--recursive" => recursive = true,
                "--force" => force = true,
                "/" => root_target = true,
                _ => {
                    // Bundled short flags, e.g. -rf, -Rf, -fr, -R, -f.
                    let is_short_bundle =
                        tok.starts_with('-') && !tok.starts_with("--") && tok.len() > 1;
                    if is_short_bundle {
                        let flags = &tok[1..];
                        if flags.contains('r') || flags.contains('R') {
                            recursive = true;
                        }
                        if flags.contains('f') {
                            force = true;
                        }
                    }
                }
            }
        }
        if saw_rm && recursive && force && root_target {
            return true;
        }
    }
    false
}

/// HARDLINE blocklist: unconditional deny. Kept small and high-precision so a
/// benign command never trips it. Patterns are anchored with sufficient context
/// that a non-root recursive `rm` (a mere risk PATTERN) is NOT caught here.
fn build_hardline() -> Vec<(&'static str, Regex)> {
    // `rm -rf /` (and -fr, extra flags, sudo) targeting the filesystem root:
    // the trailing `\s/(\s|$)` requires the slash to be root, so
    // `rm -rf /home/user/tmp` does NOT match (that is a recursive_destructive
    // PATTERN instead).
    let raw: &[(&'static str, &str)] = &[
        (
            "rm_rf_root",
            r"\brm\s+(?:-[a-zA-Z]*\s+)*-?[rf]{2,}\s*/(?:\s|$)",
        ),
        ("no_preserve_root", r"--no-preserve-root"),
        // Fork bomb `:(){ :|:& };:` matched tolerantly of inner spacing.
        ("fork_bomb", r":\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:"),
        // mkfs.<type> against a raw device node.
        ("mkfs_device", r"\bmkfs\.[a-z0-9]+\s+/dev/"),
        // Disk zeroing: dd if=/dev/zero of=/dev/sd*.
        ("dd_zero_disk", r"\bdd\s+if=/dev/zero\s+of=/dev/sd"),
        // Piping a fetched URL straight into a ROOT shell (sudo) — the
        // "url piped to a shell at filesystem root" hardline case.
        (
            "curl_pipe_root_shell",
            r"(?i)(?:curl|wget)\s+\S.*\|\s*sudo\s+(?:-\S+\s+)*(?:ba|z|k)?sh\b",
        ),
    ];
    compile_named(raw)
}

/// PATTERN set (~40 entries). Each is `(name, category, severity, regex)`.
/// A match escalates in `Manual`; `Smart` uses the max severity. Compiled once
/// per call from a static table (never inside a loop).
fn build_patterns() -> Vec<(&'static str, &'static str, Severity, Regex)> {
    use Severity::{Critical, High, Low, Medium};
    let raw: &[(&'static str, &'static str, Severity, &str)] = &[
        // ── recursive destructive ─────────────────────────────────────────────
        (
            "rm_recursive",
            "recursive_destructive",
            High,
            r"(?i)\brm\s+(?:-[a-z]*r[a-z]*|--recursive)\b",
        ),
        (
            "rm_force",
            "recursive_destructive",
            Medium,
            r"(?i)\brm\s+(?:-[a-z]*f[a-z]*|--force)\b",
        ),
        (
            "chmod_recursive_777",
            "recursive_destructive",
            High,
            r"\bchmod\s+-R\s+0?777\b|\bchmod\s+0?777\s+-R\b",
        ),
        (
            "chmod_777",
            "system_modification",
            Medium,
            r"\bchmod\s+(?:-[a-zA-Z]+\s+)*0?777\b",
        ),
        (
            "chown_recursive_root",
            "recursive_destructive",
            High,
            r"\bchown\s+-R\s+root\b",
        ),
        // ── system modification ───────────────────────────────────────────────
        ("mkfs", "system_modification", High, r"\bmkfs\b"),
        ("dd_if", "system_modification", High, r"\bdd\s+if="),
        (
            "write_dev_sd",
            "system_modification",
            Critical,
            r"\bof=/dev/sd",
        ),
        (
            "redirect_dev_disk",
            "system_modification",
            Critical,
            r">\s*/dev/(?:sd|nvme|disk)",
        ),
        (
            "redirect_etc",
            "system_modification",
            High,
            r">>?\s*/etc/",
        ),
        (
            "write_ssh_dir",
            "system_modification",
            High,
            r">>?\s*\S*\.ssh/",
        ),
        (
            "crontab_edit",
            "system_modification",
            Medium,
            r"\bcrontab\s+-",
        ),
        ("wipefs", "system_modification", High, r"\bwipefs\b"),
        ("fdisk", "system_modification", Medium, r"\bfdisk\b"),
        (
            "iptables_flush",
            "system_modification",
            Medium,
            r"\biptables\s+-F\b",
        ),
        // ── service control ───────────────────────────────────────────────────
        (
            "systemctl_control",
            "service_control",
            Medium,
            r"\bsystemctl\s+(?:stop|restart|disable|mask)\b",
        ),
        (
            "service_stop",
            "service_control",
            Medium,
            r"\bservice\s+\S+\s+stop\b",
        ),
        // ── process kill ──────────────────────────────────────────────────────
        (
            "kill_all_procs",
            "process_kill",
            High,
            r"\bkill\s+-9\s+-1\b",
        ),
        ("pkill_9", "process_kill", Medium, r"\bpkill\s+-9\b"),
        ("killall", "process_kill", Medium, r"\bkillall\b"),
        // ── code execution ────────────────────────────────────────────────────
        ("bash_c", "code_exec", High, r"\bbash\s+-c\b"),
        ("sh_c", "code_exec", High, r"\bsh\s+-c\b"),
        ("python_c", "code_exec", High, r"\bpython3?\s+-c\b"),
        ("node_e", "code_exec", High, r"\bnode\s+-e\b"),
        ("perl_e", "code_exec", Medium, r"\bperl\s+-e\b"),
        ("ruby_e", "code_exec", Medium, r"\bruby\s+-e\b"),
        ("eval_exec", "code_exec", High, r"\beval\s+\S"),
        (
            "curl_pipe_sh",
            "code_exec",
            High,
            r"(?:curl|wget)\s+\S.*\|\s*(?:ba|z|k)?sh\b",
        ),
        (
            "shell_process_sub",
            "code_exec",
            High,
            r"\b(?:ba)?sh\s+<\(\s*(?:curl|wget)",
        ),
        // ── sensitive overwrites ──────────────────────────────────────────────
        (
            "tee_etc",
            "sensitive_overwrite",
            High,
            r"\btee\s+(?:-a\s+)?/etc/",
        ),
        (
            "overwrite_bashrc",
            "sensitive_overwrite",
            High,
            r">>?\s*\S*\.bashrc\b",
        ),
        (
            "overwrite_shell_profile",
            "sensitive_overwrite",
            Medium,
            r">>?\s*\S*\.(?:profile|zshrc|bash_profile)\b",
        ),
        (
            "overwrite_authorized_keys",
            "sensitive_overwrite",
            High,
            r">>?\s*\S*authorized_keys",
        ),
        (
            "overwrite_hosts",
            "sensitive_overwrite",
            High,
            r">>?\s*/etc/hosts\b",
        ),
        (
            "overwrite_passwd",
            "sensitive_overwrite",
            Critical,
            r">>?\s*/etc/(?:passwd|shadow|sudoers)\b",
        ),
        // ── dangerous combos ──────────────────────────────────────────────────
        (
            "find_exec_rm",
            "dangerous_combo",
            High,
            r"\bfind\b.*-exec\s+rm\b",
        ),
        (
            "xargs_rm",
            "dangerous_combo",
            High,
            r"\bxargs\s+(?:-\S+\s+)*rm\b",
        ),
        (
            "sed_inplace_etc",
            "dangerous_combo",
            High,
            r"\bsed\s+-i\b.*/etc/",
        ),
        (
            "git_clean_force",
            "dangerous_combo",
            Medium,
            r"\bgit\s+clean\s+-[a-zA-Z]*f[a-zA-Z]*d[a-zA-Z]*\b|\bgit\s+clean\s+-[a-zA-Z]*d[a-zA-Z]*f[a-zA-Z]*\b",
        ),
        (
            "truncate_zero",
            "dangerous_combo",
            Medium,
            r"\btruncate\s+-s\s*0\b",
        ),
        ("shred", "dangerous_combo", High, r"\bshred\b"),
        (
            "history_clear",
            "dangerous_combo",
            Low,
            r"\bhistory\s+-c\b",
        ),
    ];
    raw.iter()
        .filter_map(|(name, category, severity, pat)| match Regex::new(pat) {
            Ok(re) => Some((*name, *category, *severity, re)),
            Err(e) => {
                tracing::error!("Failed to compile cmdscan pattern '{name}': {e}");
                None
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn approval_mode_from_env_str() {
        assert_eq!(ApprovalMode::from_env_str("off"), ApprovalMode::Off);
        assert_eq!(ApprovalMode::from_env_str(" SMART "), ApprovalMode::Smart);
        assert_eq!(ApprovalMode::from_env_str("manual"), ApprovalMode::Manual);
        // Unknown / empty defaults to Manual (safest).
        assert_eq!(ApprovalMode::from_env_str("garbage"), ApprovalMode::Manual);
        assert_eq!(ApprovalMode::from_env_str(""), ApprovalMode::Manual);
    }

    #[test]
    fn hardline_always_denies_regardless_of_mode() {
        for mode in [ApprovalMode::Off, ApprovalMode::Manual, ApprovalMode::Smart] {
            let v = scan_command("bash", "rm -rf /", mode);
            assert_eq!(v.decision, Decision::Deny, "mode {mode:?} must deny rm -rf /");
            assert!(
                v.reason.as_deref().unwrap_or("").contains("hardline"),
                "reason should mention hardline: {:?}",
                v.reason
            );
            assert_eq!(v.findings.len(), 1);
            assert_eq!(v.findings[0].severity, Severity::Critical);
        }
    }

    #[test]
    fn hardline_covers_fork_bomb_and_no_preserve_root() {
        assert_eq!(
            scan_command("bash", ":(){ :|:& };:", ApprovalMode::Off).decision,
            Decision::Deny
        );
        assert_eq!(
            scan_command("bash", "rm -rf --no-preserve-root /", ApprovalMode::Off).decision,
            Decision::Deny
        );
    }

    #[test]
    fn off_skips_non_hardline() {
        // Recursive destructive but NOT rooted → a PATTERN, not hardline. Off
        // mode ignores patterns, so this is allowed.
        let v = scan_command("bash", "rm -rf /home/user/tmp", ApprovalMode::Off);
        assert_eq!(v.decision, Decision::Allow, "got {v:?}");
        assert!(v.findings.is_empty());
    }

    #[test]
    fn benign_command_allows() {
        let v = scan_command("bash", "ls -la", ApprovalMode::Manual);
        assert_eq!(v.decision, Decision::Allow);
        assert!(v.findings.is_empty());
    }

    #[test]
    fn manual_escalates_pattern() {
        let v = scan_command("bash", "systemctl stop nginx", ApprovalMode::Manual);
        assert_eq!(v.decision, Decision::ApprovalRequired);
        assert!(!v.findings.is_empty());
        assert!(v.findings.iter().any(|f| f.pattern == "systemctl_control"));
    }

    #[test]
    fn smart_denies_critical() {
        // Writing to /etc/passwd is Critical but not hardline → Smart denies.
        let v = scan_command("bash", "echo pwned > /etc/passwd", ApprovalMode::Smart);
        assert_eq!(v.decision, Decision::Deny, "got {v:?}");
        assert!(v.findings.iter().any(|f| f.severity == Severity::Critical));
    }

    #[test]
    fn smart_allows_low_only() {
        // history -c is the only Low pattern; Smart auto-allows a low-only hit.
        let v = scan_command("bash", "history -c", ApprovalMode::Smart);
        assert_eq!(v.decision, Decision::Allow, "got {v:?}");
        assert!(v.findings.iter().all(|f| f.severity == Severity::Low));
    }

    #[test]
    fn smart_escalates_high() {
        let v = scan_command("bash", "systemctl stop nginx", ApprovalMode::Smart);
        assert_eq!(v.decision, Decision::ApprovalRequired);
    }

    #[test]
    fn non_root_recursive_rm_is_pattern_not_hardline() {
        // Under Manual this recursive rm must escalate (approval), proving it is
        // a PATTERN and never silently allowed.
        let v = scan_command("bash", "rm -rf /home/user/tmp", ApprovalMode::Manual);
        assert_eq!(v.decision, Decision::ApprovalRequired);
        assert!(v.findings.iter().any(|f| f.pattern == "rm_recursive"));
    }

    #[test]
    fn separated_and_longform_rm_root_is_hardline_all_modes() {
        // Flags separated, reversed, GNU long form, and uppercase -R all evade
        // the contiguous `-?[rf]{2,}` regex but must still hardline-deny in EVERY
        // mode, including Off (hardline runs before the Off short-circuit).
        let evasions = [
            "rm -r -f /",
            "rm -f -r /",
            "rm --recursive --force /",
            "rm -R -f /",
        ];
        for cmd in evasions {
            for mode in [ApprovalMode::Off, ApprovalMode::Manual] {
                let v = scan_command("bash", cmd, mode);
                assert_eq!(
                    v.decision,
                    Decision::Deny,
                    "cmd {cmd:?} mode {mode:?} must hardline-deny, got {v:?}"
                );
                assert!(
                    v.reason.as_deref().unwrap_or("").contains("hardline"),
                    "cmd {cmd:?} reason should mention hardline: {:?}",
                    v.reason
                );
                assert_eq!(v.findings.len(), 1);
                assert_eq!(v.findings[0].severity, Severity::Critical);
            }
        }
    }

    #[test]
    fn rm_root_in_pipeline_segment_is_hardline() {
        // `rm` in a later pipeline/list segment is still analyzed against its own
        // flags and denied.
        let v = scan_command("bash", "echo hi && rm -r -f /", ApprovalMode::Off);
        assert_eq!(v.decision, Decision::Deny, "got {v:?}");
        assert!(v.reason.as_deref().unwrap_or("").contains("hardline"));
    }

    #[test]
    fn benign_recursive_force_rm_is_not_hardline() {
        // Recursive + force but NOT targeting bare root. Off ignores risk
        // PATTERNs, so these are allowed - proving they are not hardline-denied.
        for cmd in ["rm -rf ./build", "rm -rf /home/user/tmp/x"] {
            let v = scan_command("bash", cmd, ApprovalMode::Off);
            assert_eq!(v.decision, Decision::Allow, "cmd {cmd:?} got {v:?}");
            assert!(v.findings.is_empty(), "cmd {cmd:?} got {v:?}");
        }
    }

    #[test]
    fn longform_recursive_rm_no_force_nonroot_is_not_hardline() {
        // `rm --recursive` (no force, non-root) must NOT be hardline. It should
        // still escalate under Manual via the broadened rm_recursive pattern.
        let v = scan_command("bash", "rm --recursive /home/user/proj", ApprovalMode::Manual);
        assert_eq!(v.decision, Decision::ApprovalRequired, "got {v:?}");
        assert!(v.reason.as_deref().unwrap_or("").contains("manual"));
        assert!(v.findings.iter().any(|f| f.pattern == "rm_recursive"));
    }

    #[test]
    fn uppercase_recursive_rm_escalates_under_manual() {
        // `rm -R` (uppercase, non-root) escalates via the case-insensitive
        // broadened pattern.
        let v = scan_command("bash", "rm -R /home/user/proj", ApprovalMode::Manual);
        assert_eq!(v.decision, Decision::ApprovalRequired, "got {v:?}");
        assert!(v.findings.iter().any(|f| f.pattern == "rm_recursive"));
    }
}
